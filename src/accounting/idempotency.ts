import { createHash } from 'node:crypto';
import type { AccountingSourceType } from './types.js';

export type IdempotencyInput = {
  sourceType: AccountingSourceType;
  sourceId: string;
  lineNumber: number;
  fiscalPeriod: string;
  documentSha256?: string;
};

/** 同じ元データ・明細・会計期間からは必ず同じキーを生成する。 */
export function createAccountingIdempotencyKey(input: IdempotencyInput): string {
  const canonical = [
    input.sourceType,
    input.sourceId.trim(),
    String(input.lineNumber),
    input.fiscalPeriod,
    input.documentSha256?.toLowerCase() ?? '',
  ].join('|');

  return `acct_${createHash('sha256').update(canonical).digest('hex').slice(0, 24)}`;
}

