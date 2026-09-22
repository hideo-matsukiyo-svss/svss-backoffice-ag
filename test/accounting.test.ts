import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountingIdempotencyKey } from '../src/accounting/idempotency.js';
import { checkMfCloudInvoiceLinkage } from '../src/accounting/mf-cloud-invoice.js';
import { MF_JOURNAL_HEADERS, toMoneyForwardJournalCsv } from '../src/accounting/mf-journal-csv.js';
import { applyAccountingRules } from '../src/accounting/rules.js';
import type { JournalCandidate } from '../src/accounting/types.js';

test('冪等キーは入力が同じなら同一で、明細番号が違えば変わる', () => {
  const base = {
    sourceType: 'vendor_invoice_email' as const,
    sourceId: 'mail-123',
    fiscalPeriod: '2026-09',
    documentSha256: 'ABCDEF',
  };
  assert.equal(
    createAccountingIdempotencyKey({ ...base, lineNumber: 1 }),
    createAccountingIdempotencyKey({ ...base, lineNumber: 1 }),
  );
  assert.notEqual(
    createAccountingIdempotencyKey({ ...base, lineNumber: 1 }),
    createAccountingIdempotencyKey({ ...base, lineNumber: 2 }),
  );
});

test('MFクラウド請求書の標準連携を検査できる', () => {
  const result = checkMfCloudInvoiceLinkage(
    {
      invoiceId: 'inv-1', invoiceNumber: '2026-001', issueDate: '2026-09-01',
      journalDate: '2026-09-01', totalAmount: 110000, linkageStatus: 'posted',
      debitAccount: '売掛金', creditAccount: '売上高', department: '営業',
      taxCategory: '課売 10%',
    },
    {
      expectedDebitAccount: '売掛金', expectedCreditAccount: '売上高',
      expectedDepartment: '営業', expectedTaxCategory: '課売 10%',
    },
  );
  assert.deepEqual(result, { ok: true, issues: [] });
});

test('承認済みの受領請求書をMF仕訳帳CSVへ変換する', () => {
  const candidate: JournalCandidate = {
    idempotencyKey: 'acct_1', sourceType: 'vendor_invoice_email', sourceId: 'mail-1',
    lineNumber: 1, fiscalPeriod: '2026-09', transactionDate: '2026-09-15',
    debit: { account: '外注費', taxCategory: '課仕 10%', amount: 110000 },
    credit: { account: '未払金', counterparty: '取引先A', amount: 110000 },
    description: '9月分,業務委託費', memo: 'acct_1', tags: ['自動化', '要証憑'],
    evidence: [{ uri: 'gs://evidence/invoice.pdf', documentType: 'invoice' }],
    approvalStatus: 'approved',
  };
  const csv = toMoneyForwardJournalCsv([candidate], 100);
  assert.equal(csv.split('\r\n')[0], MF_JOURNAL_HEADERS.join(','));
  assert.match(csv, /100,2026\/09\/15,外注費/);
  assert.match(csv, /"9月分,業務委託費"/);
});

test('売上はCSVへ重複出力しない', () => {
  const candidate = {
    idempotencyKey: 'acct_sales', sourceType: 'moneyforward_cloud_invoice',
    sourceId: 'inv-1', lineNumber: 1, fiscalPeriod: '2026-09',
    transactionDate: '2026-09-15',
    debit: { account: '売掛金', amount: 110000 },
    credit: { account: '売上高', amount: 110000 },
    description: '売上', evidence: [], approvalStatus: 'approved',
  } satisfies JournalCandidate;
  assert.throws(() => toMoneyForwardJournalCsv([candidate]), /標準連携/);
});

test('承認済みルールから要確認の仕訳候補を生成する', () => {
  const result = applyAccountingRules(
    {
      sourceType: 'expense_reimbursement', sourceId: 'expense-1', lineNumber: 1,
      fiscalPeriod: '2026-09', transactionDate: '2026-09-20', amount: 1200,
      description: '顧客訪問 電車代', category: '交通費', counterparty: 'JR',
      departmentHint: '営業', documentSha256: 'abc',
      evidence: [{ uri: 'gs://evidence/receipt.pdf', documentType: 'receipt' }],
    },
    {
      version: '2026-09', requireEvidence: true, requireDepartment: true,
      rules: [{
        id: 'transport', enabled: true, priority: 10,
        when: { sourceTypes: ['expense_reimbursement'], category: '交通費' },
        debit: { account: '旅費交通費', department: '営業', taxCategory: '課仕 10%' },
        credit: { account: '未払金' }, tags: ['立替経費'],
      }],
    },
  );
  assert.equal(result.status, 'candidate');
  if (result.status === 'candidate') {
    assert.equal(result.candidate.approvalStatus, 'needs_review');
    assert.equal(result.candidate.debit.account, '旅費交通費');
    assert.equal(result.candidate.credit.counterparty, 'JR');
  }
});

test('未登録または競合するルールは人レビューへ送る', () => {
  const facts = {
    sourceType: 'vendor_invoice_email' as const, sourceId: 'mail-2', lineNumber: 1,
    fiscalPeriod: '2026-09', transactionDate: '2026-09-20', amount: 50000,
    description: 'システム利用料', counterparty: 'Vendor A',
    evidence: [{ uri: 'gs://evidence/invoice.pdf', documentType: 'invoice' as const }],
  };
  const noMatch = applyAccountingRules(facts, {
    version: '1', requireEvidence: true, requireDepartment: false, rules: [],
  });
  assert.equal(noMatch.status, 'needs_review');
  assert.equal(noMatch.issues[0]?.code, 'NO_MATCHING_RULE');

  const duplicateRule = {
    enabled: true, priority: 10,
    when: { sourceTypes: ['vendor_invoice_email' as const], counterparty: 'Vendor A' },
    debit: { account: '通信費' }, credit: { account: '未払金' },
  };
  const conflict = applyAccountingRules(facts, {
    version: '1', requireEvidence: true, requireDepartment: false,
    rules: [
      { id: 'rule-a', ...duplicateRule },
      { id: 'rule-b', ...duplicateRule },
    ],
  });
  assert.equal(conflict.status, 'needs_review');
  assert.equal(conflict.issues[0]?.code, 'CONFLICTING_RULES');
});
