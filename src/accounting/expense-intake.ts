import { createHash } from 'node:crypto';
import { applyAccountingRules } from './rules.js';
import type { JournalCandidate } from './types.js';
import {
  accountingRuleSetSchema, expenseBatchSchema, expenseRecordSchema,
  type ExpenseRecord,
} from './input-validation.js';

type ReviewIssue = { code: string; message: string };
export type ExpenseReviewItem = {
  row: number;
  status: 'candidate' | 'needs_review' | 'invalid';
  record?: ExpenseRecord;
  sourceKey?: string;
  matchedRuleIds: string[];
  issues: ReviewIssue[];
  candidate?: JournalCandidate;
};

export type ExpenseReviewReport = {
  schemaVersion: 1;
  mode: 'dry_run';
  organizationId: string;
  sourceSystem: string;
  targetMonth: string;
  ruleSetVersion: string;
  scanNotices: { code: string; fileId: string; message: string }[];
  summary: { total: number; candidates: number; needsReview: number; invalid: number };
  items: ExpenseReviewItem[];
};

/** 修正された金額・証憑・計上月によって同一明細のIDが変わらないようにする。 */
export function expenseSourceKey(
  organizationId: string, sourceSystem: string, fileId: string, lineId: string,
): string {
  const identity = [organizationId, sourceSystem, fileId, lineId].map((part) => part.trim());
  return `expense_${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function add(index: Map<string, Set<number>>, key: string, row: number): void {
  const rows = index.get(key) ?? new Set<number>();
  rows.add(row);
  index.set(key, rows);
}

/**
 * 単一バッチの読取・正規化・重複照合・ルール適用を行う純粋関数。
 * 承認、CSV出力、MF登録、永続的な処理済み登録は行わない。
 */
export function reviewExpenseBatch(input: unknown, configuration: unknown): ExpenseReviewReport {
  const batch = expenseBatchSchema.parse(input);
  const ruleSet = accountingRuleSetSchema.parse(configuration);
  const identities = new Map<string, Set<number>>();
  const receipts = new Map<string, Set<number>>();

  // 不正金額などで後の検証に失敗する行も重複照合に含める。
  batch.records.forEach((value, index) => {
    const record = object(value);
    if (!record) return;
    const lineId = record.lineId === undefined ? '1' : record.lineId;
    if (typeof record.fileId === 'string' && record.fileId.trim()
      && typeof lineId === 'string' && lineId.trim()) {
      add(identities, expenseSourceKey(batch.organizationId, batch.sourceSystem,
        record.fileId, lineId), index + 1);
    }
    if (Array.isArray(record.evidence)) {
      for (const reference of record.evidence) {
        const hash = object(reference)?.sha256;
        if (typeof hash === 'string' && /^[a-fA-F0-9]{64}$/.test(hash.trim())) {
          add(receipts, hash.trim().toLowerCase(), index + 1);
        }
      }
    }
  });

  const items: ExpenseReviewItem[] = batch.records.map((value, index) => {
    const row = index + 1;
    const parsed = expenseRecordSchema.safeParse(value);
    if (!parsed.success) {
      return {
        row, status: 'invalid', matchedRuleIds: [],
        issues: parsed.error.issues.map((issue) => ({
          code: 'INVALID_RECORD', message: `${issue.path.join('.')}: ${issue.message}`,
        })),
      };
    }
    const record = parsed.data;
    const sourceKey = expenseSourceKey(batch.organizationId, batch.sourceSystem,
      record.fileId, record.lineId);
    const issues: ReviewIssue[] = [];
    const flag = (code: string, message: string) => issues.push({ code, message });
    for (const field of ['transactionDate', 'amount', 'category', 'merchant', 'description', 'department'] as const) {
      if (record[field] === undefined) flag('MISSING_FIELD', `${field}: 証憑の読取・確認が必要です`);
    }
    if (record.transactionDate && record.transactionDate.slice(0, 7) !== batch.targetMonth) {
      flag('OUTSIDE_TARGET_MONTH', '利用日が対象月と異なります。計上日を確認してください');
    }
    if (!record.employee?.accountingCounterparty) {
      flag('EMPLOYEE_NOT_MAPPED', '人別フォルダと精算する社員のMF取引先名の対応が未設定です');
    }
    if (record.evidence.length === 0) flag('MISSING_RECEIPT', '領収書がありません');
    if (record.evidence.some((reference) => !reference.sha256)) {
      flag('MISSING_RECEIPT_HASH', '領収書のハッシュがなく、重複を確認できません');
    }
    const identityRows = identities.get(sourceKey)!;
    if (identityRows.size > 1) {
      flag('DUPLICATE_SOURCE', `同一ファイル・明細があります（行: ${[...identityRows].join(', ')}）`);
    }
    const duplicateReceiptRows = new Set<number>();
    for (const reference of record.evidence) {
      for (const otherRow of receipts.get(reference.sha256 ?? '') ?? []) {
        if (otherRow !== row) duplicateReceiptRows.add(otherRow);
      }
    }
    if (duplicateReceiptRows.size) {
      flag('DUPLICATE_RECEIPT', `同じ領収書を使う別明細があります（行: ${[...duplicateReceiptRows].join(', ')}）`);
    }

    // 経費申請の承認は要求しない。不足情報は推測せず、計上前の確認対象とする。
    if (record.transactionDate === undefined || record.amount === undefined
      || !record.category || !record.merchant || !record.description || !record.department) {
      return { row, status: 'needs_review', record, sourceKey, issues, matchedRuleIds: [] };
    }
    const decision = applyAccountingRules({
      sourceType: 'expense_reimbursement',
      sourceId: JSON.stringify([batch.organizationId, batch.sourceSystem, record.fileId, record.lineId]),
      lineNumber: 1,
      fiscalPeriod: batch.targetMonth,
      transactionDate: record.transactionDate,
      amount: record.amount,
      description: record.description,
      category: record.category,
      counterparty: record.merchant,
      departmentHint: record.department,
      evidence: record.evidence,
    }, ruleSet);
    issues.push(...decision.issues);

    if (decision.status === 'candidate') {
      const candidate = decision.candidate;
      if (candidate.debit.department && candidate.debit.department !== record.department) {
        flag('DEPARTMENT_MISMATCH', '費用計上先の部門が社員の設定部門と異なります');
      }
      if (candidate.credit.department && candidate.credit.department !== record.department) {
        flag('DEPARTMENT_MISMATCH', '貸方の部門が社員の設定部門と異なります');
      }
      const rule = ruleSet.rules.find((entry) => entry.id === decision.matchedRuleIds[0])!;
      if (rule.credit.counterparty && rule.credit.counterparty !== record.employee?.accountingCounterparty) {
        flag('PAYEE_MISMATCH', 'ルールの貸方取引先が精算する社員と異なります');
      }
      if (issues.length === 0) {
        return {
          row, status: 'candidate', sourceKey, record, issues,
          matchedRuleIds: decision.matchedRuleIds,
          candidate: {
            ...candidate,
            idempotencyKey: sourceKey,
            credit: { ...candidate.credit, counterparty: record.employee?.accountingCounterparty },
            approvalStatus: 'needs_review',
          },
        };
      }
    }
    return { row, status: 'needs_review', record, sourceKey, issues, matchedRuleIds: decision.matchedRuleIds };
  });

  return {
    schemaVersion: 1, mode: 'dry_run', organizationId: batch.organizationId,
    sourceSystem: batch.sourceSystem, targetMonth: batch.targetMonth, ruleSetVersion: ruleSet.version,
    scanNotices: batch.scanNotices,
    summary: {
      total: items.length,
      candidates: items.filter((item) => item.status === 'candidate').length,
      needsReview: items.filter((item) => item.status === 'needs_review').length,
      invalid: items.filter((item) => item.status === 'invalid').length,
    },
    items,
  };
}
