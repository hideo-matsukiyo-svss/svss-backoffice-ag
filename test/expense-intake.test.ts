import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reviewExpenseBatch, expenseSourceKey } from '../src/accounting/expense-intake.js';
import { isCalendarDate, expenseRecordSchema } from '../src/accounting/input-validation.js';
import { toMoneyForwardJournalCsv } from '../src/accounting/mf-journal-csv.js';

const demo = JSON.parse(await readFile(new URL('../examples/accounting/expenses.demo.json', import.meta.url), 'utf8'));
const rules = JSON.parse(await readFile(new URL('../examples/accounting/rules.demo.json', import.meta.url), 'utf8'));
const base = expenseRecordSchema.parse(demo.records[0]);
const batch = (records: unknown[]) => ({ ...demo, records });
const review = (record: unknown) => reviewExpenseBatch(batch([record]), rules).items[0];

test('デモは候補1・要確認3・不正1。申請承認を要求しない', () => {
  assert.deepEqual(reviewExpenseBatch(demo, rules).summary, { total: 5, candidates: 1, needsReview: 3, invalid: 1 });
  const item = review(base);
  assert.equal(item.status, 'candidate');
  assert.equal(item.candidate?.debit.counterparty, 'デモ鉄道');
  assert.equal(item.candidate?.credit.counterparty, 'デモ社員取引先');
  assert.equal(item.candidate?.approvalStatus, 'needs_review');
  assert.throws(() => toMoneyForwardJournalCsv([item.candidate!]), /承認/);
});

test('未読取の証憑は推測で埋めず不足項目を返す', () => {
  const item = review({ fileId: 'new-file', evidence: [] });
  assert.equal(item.status, 'needs_review');
  assert.equal(item.candidate, undefined);
  assert.equal(item.issues.filter((issue) => issue.code === 'MISSING_FIELD').length, 6);
  assert.ok(item.issues.some((issue) => issue.code === 'EMPLOYEE_NOT_MAPPED'));
  assert.ok(item.issues.some((issue) => issue.code === 'MISSING_RECEIPT'));
});

test('不正な日付・金額・未知の列・SHAは入力不正', () => {
  for (const patch of [
    { transactionDate: '2026-02-29' }, { transactionDate: '2026-09-31' },
    { amount: 0 }, { amount: -100 }, { amount: 1.5 }, { amount: '100' },
    { amount: Number.MAX_SAFE_INTEGER + 1 }, { applicationStatus: 'approved' },
    { evidence: [{ ...base.evidence[0], sha256: 'abc' }] },
  ]) assert.equal(review({ ...base, ...patch }).status, 'invalid');
  assert.equal(isCalendarDate('2024-02-29'), true);
  assert.equal(isCalendarDate('0000-01-01'), false);
});

test('同一ファイルの修正はキーを維持、社員フォルダ名や計上月に依存しない', () => {
  const original = review(base);
  const changed = review({ ...base, amount: 999, transactionDate: '2026-09-22', personFolderName: '改名' });
  assert.equal(original.sourceKey, changed.sourceKey);
  assert.equal(original.sourceKey, expenseSourceKey(demo.organizationId, 'google_drive', base.fileId, '1'));
  assert.notEqual(original.sourceKey, expenseSourceKey('different-company', 'google_drive', base.fileId, '1'));
  assert.notEqual(original.sourceKey, expenseSourceKey(demo.organizationId, 'google_drive', base.fileId, '2'));
});

test('同一ファイル・同一SHAの全行を止め、不正行との重複も見逃さない', () => {
  const report = reviewExpenseBatch(batch([base, { ...base, amount: -1 }]), rules);
  assert.equal(report.summary.candidates, 0);
  assert.ok(report.items[0].issues.some((issue) => issue.code === 'DUPLICATE_SOURCE'));
  assert.ok(report.items[0].issues.some((issue) => issue.code === 'DUPLICATE_RECEIPT'));
  const copies = reviewExpenseBatch(batch([base, { ...base, fileId: 'copy',
    evidence: [{ ...base.evidence[0], sha256: base.evidence[0].sha256!.toUpperCase() }] }]), rules);
  assert.equal(copies.summary.needsReview, 2);
  assert.equal(copies.summary.candidates, 0);
});

test('社員未設定・ハッシュなし・対象月外・部門不一致は候補にしない', () => {
  const cases = [
    [{ employee: { id: 'employee', name: 'デモ' } }, 'EMPLOYEE_NOT_MAPPED'],
    [{ evidence: [{ uri: 'https://example.invalid/receipt', documentType: 'receipt' }] }, 'MISSING_RECEIPT_HASH'],
    [{ transactionDate: '2026-08-31' }, 'OUTSIDE_TARGET_MONTH'],
    [{ department: '異なる部門' }, 'DEPARTMENT_MISMATCH'],
  ] as const;
  for (const [patch, code] of cases) {
    const item = review({ ...base, ...patch });
    assert.equal(item.candidate, undefined);
    assert.ok(item.issues.some((issue) => issue.code === code));
  }
});

test('ルールなし・競合・貸方社員不一致を止める', () => {
  const noMatch = reviewExpenseBatch(batch([base]), { ...rules, rules: [] }).items[0];
  assert.equal(noMatch.issues[0].code, 'NO_MATCHING_RULE');
  const conflict = reviewExpenseBatch(batch([base]), { ...rules,
    rules: [...rules.rules, { ...rules.rules[0], id: 'other' }] }).items[0];
  assert.equal(conflict.issues[0].code, 'CONFLICTING_RULES');
  const mismatch = reviewExpenseBatch(batch([base]), { ...rules, rules: [{ ...rules.rules[0],
    credit: { ...rules.rules[0].credit, counterparty: '別社員' } }] }).items[0];
  assert.equal(mismatch.issues[0].code, 'PAYEE_MISMATCH');
});

test('設定不正はバッチ全体を拒否、未有効の設定ひな形は使える', async () => {
  for (const rule of [
    { ...rules.rules[0], debit: { ...rules.rules[0].debit, account: '__未設定__' } },
    { ...rules.rules[0], credit: { account: '未払金' } },
  ]) assert.throws(() => reviewExpenseBatch(demo, { ...rules, rules: [rule] }));
  assert.throws(() => reviewExpenseBatch({ ...demo, targetMonth: '2026-13' }, rules));
  assert.throws(() => reviewExpenseBatch(demo, { ...rules, rules: [rules.rules[0], rules.rules[0]] }));
  const template = JSON.parse(await readFile(new URL('../config/accounting-rules.example.json', import.meta.url), 'utf8'));
  assert.equal(reviewExpenseBatch(batch([base]), template).summary.candidates, 0);
});

test('空フォルダも正常な0件レポートとなり、スキャン時の注意事項を保持する', () => {
  const notices = [{ code: 'EMPTY_MONTH', fileId: 'month', message: '空です' }];
  const result = reviewExpenseBatch({ ...batch([]), scanNotices: notices }, rules);
  assert.equal(result.summary.total, 0);
  assert.deepEqual(result.scanNotices, notices);
});

test('CLIがレポートを書き出し、既存ファイルを上書きしない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'expense-cli-test-'));
  const output = join(dir, 'review.json');
  const args = ['--import', 'tsx', 'src/accounting/review-expenses.ts',
    '--input', 'examples/accounting/expenses.demo.json', '--rules', 'examples/accounting/rules.demo.json', '--output', output];
  const first = spawnSync(process.execPath, args, { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  const bytes = await readFile(output, 'utf8');
  assert.equal(JSON.parse(bytes).summary.candidates, 1);
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  const second = spawnSync(process.execPath, args, { cwd: resolve('.'), encoding: 'utf8' });
  assert.equal(second.status, 1);
  assert.equal(await readFile(output, 'utf8'), bytes);
});
