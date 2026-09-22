import { createAccountingIdempotencyKey } from './idempotency.js';
import type {
  AccountingSourceType,
  EvidenceReference,
  JournalCandidate,
  JournalSide,
} from './types.js';

export type TransactionFacts = {
  sourceType: AccountingSourceType;
  sourceId: string;
  lineNumber: number;
  fiscalPeriod: string;
  transactionDate: string;
  amount: number;
  description: string;
  category?: string;
  counterparty?: string;
  departmentHint?: string;
  documentSha256?: string;
  evidence: EvidenceReference[];
};

export type RuleCondition = {
  sourceTypes: AccountingSourceType[];
  category?: string;
  counterparty?: string;
  descriptionIncludes?: string[];
  departmentHint?: string;
};

export type RuleSide = Omit<JournalSide, 'amount'>;

export type AccountingRule = {
  id: string;
  enabled: boolean;
  priority: number;
  when: RuleCondition;
  debit: RuleSide;
  credit: RuleSide;
  tags?: string[];
};

export type AccountingRuleSet = {
  version: string;
  requireEvidence: boolean;
  requireDepartment: boolean;
  rules: AccountingRule[];
};

export type RuleIssue = {
  code:
    | 'SALES_USES_NATIVE_LINKAGE'
    | 'INVALID_AMOUNT'
    | 'INVALID_DATE'
    | 'MISSING_EVIDENCE'
    | 'NO_MATCHING_RULE'
    | 'CONFLICTING_RULES'
    | 'INCOMPLETE_RULE';
  message: string;
};

export type RuleDecision =
  | { status: 'needs_review'; issues: RuleIssue[]; matchedRuleIds: string[] }
  | {
      status: 'candidate';
      candidate: JournalCandidate;
      issues: RuleIssue[];
      matchedRuleIds: string[];
    };

function same(left: string | undefined, right: string | undefined): boolean {
  return left?.trim().toLowerCase() === right?.trim().toLowerCase();
}

function matches(rule: AccountingRule, facts: TransactionFacts): boolean {
  const condition = rule.when;
  if (!rule.enabled || !condition.sourceTypes.includes(facts.sourceType)) return false;
  if (condition.category && !same(condition.category, facts.category)) return false;
  if (condition.counterparty && !same(condition.counterparty, facts.counterparty)) return false;
  if (condition.departmentHint && !same(condition.departmentHint, facts.departmentHint)) {
    return false;
  }
  if (
    condition.descriptionIncludes?.length &&
    !condition.descriptionIncludes.every((word) =>
      facts.description.toLowerCase().includes(word.toLowerCase()),
    )
  ) {
    return false;
  }
  return true;
}

function ruleIsComplete(rule: AccountingRule, ruleSet: AccountingRuleSet): boolean {
  if (!rule.id.trim() || !rule.debit.account.trim() || !rule.credit.account.trim()) return false;
  if (ruleSet.requireDepartment && !rule.debit.department && !rule.credit.department) return false;
  return true;
}

/**
 * 取引情報に、経理が承認した決定表を適用する。
 * 一致しない・競合する・不足する場合は仕訳を作らず、人レビューへ送る。
 */
export function applyAccountingRules(
  facts: TransactionFacts,
  ruleSet: AccountingRuleSet,
): RuleDecision {
  const issues: RuleIssue[] = [];

  if (facts.sourceType === 'moneyforward_cloud_invoice') {
    return {
      status: 'needs_review',
      matchedRuleIds: [],
      issues: [{
        code: 'SALES_USES_NATIVE_LINKAGE',
        message: '売上はMFクラウド請求書の標準連携を検査し、このルールでは仕訳を作りません',
      }],
    };
  }
  if (!Number.isInteger(facts.amount) || facts.amount <= 0) {
    issues.push({ code: 'INVALID_AMOUNT', message: '金額は正の整数で指定してください' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(facts.transactionDate)) {
    issues.push({ code: 'INVALID_DATE', message: '取引日はYYYY-MM-DD形式で指定してください' });
  }
  if (ruleSet.requireEvidence && facts.evidence.length === 0) {
    issues.push({ code: 'MISSING_EVIDENCE', message: '証憑がありません' });
  }

  const matched = ruleSet.rules.filter((rule) => matches(rule, facts));
  if (matched.length === 0) {
    issues.push({ code: 'NO_MATCHING_RULE', message: '一致する会計ルールがありません' });
    return { status: 'needs_review', issues, matchedRuleIds: [] };
  }

  const bestPriority = Math.min(...matched.map((rule) => rule.priority));
  const best = matched.filter((rule) => rule.priority === bestPriority);
  if (best.length > 1) {
    issues.push({
      code: 'CONFLICTING_RULES',
      message: `同じ優先度のルールが競合しています: ${best.map((rule) => rule.id).join(', ')}`,
    });
    return { status: 'needs_review', issues, matchedRuleIds: best.map((rule) => rule.id) };
  }

  const rule = best[0];
  if (!ruleIsComplete(rule, ruleSet)) {
    issues.push({ code: 'INCOMPLETE_RULE', message: `ルールの設定が不足しています: ${rule.id}` });
  }
  if (issues.length > 0) {
    return { status: 'needs_review', issues, matchedRuleIds: [rule.id] };
  }

  const candidate: JournalCandidate = {
    idempotencyKey: createAccountingIdempotencyKey({
      sourceType: facts.sourceType,
      sourceId: facts.sourceId,
      lineNumber: facts.lineNumber,
      fiscalPeriod: facts.fiscalPeriod,
      documentSha256: facts.documentSha256,
    }),
    sourceType: facts.sourceType,
    sourceId: facts.sourceId,
    lineNumber: facts.lineNumber,
    fiscalPeriod: facts.fiscalPeriod,
    transactionDate: facts.transactionDate,
    debit: { ...rule.debit, counterparty: rule.debit.counterparty ?? facts.counterparty, amount: facts.amount },
    credit: { ...rule.credit, counterparty: rule.credit.counterparty ?? facts.counterparty, amount: facts.amount },
    description: facts.description,
    memo: `rule:${rule.id} / ruleset:${ruleSet.version}`,
    tags: rule.tags,
    evidence: facts.evidence,
    approvalStatus: 'needs_review',
  };

  return { status: 'candidate', candidate, issues: [], matchedRuleIds: [rule.id] };
}

