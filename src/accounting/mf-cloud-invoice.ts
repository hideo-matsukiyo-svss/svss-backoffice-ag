export type MfInvoiceLinkageStatus = 'unlinked' | 'candidate' | 'posted' | 'error';

export type MfCloudInvoiceRecord = {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: string;
  journalDate?: string;
  totalAmount: number;
  linkageStatus: MfInvoiceLinkageStatus;
  debitAccount?: string;
  creditAccount?: string;
  department?: string;
  taxCategory?: string;
  errorMessage?: string;
};

export type SalesLinkagePolicy = {
  expectedDebitAccount?: string;
  expectedCreditAccount?: string;
  expectedDepartment?: string;
  expectedTaxCategory?: string;
};

export type SalesLinkageIssue = {
  code:
    | 'NOT_LINKED'
    | 'LINKAGE_ERROR'
    | 'MISSING_JOURNAL_DATE'
    | 'INVALID_AMOUNT'
    | 'ACCOUNT_MISMATCH'
    | 'DEPARTMENT_MISMATCH'
    | 'TAX_CATEGORY_MISMATCH';
  message: string;
};

/**
 * 売上仕訳は作成せず、MFクラウド請求書→クラウド会計の標準連携だけを検査する。
 */
export function checkMfCloudInvoiceLinkage(
  invoice: MfCloudInvoiceRecord,
  policy: SalesLinkagePolicy = {},
): { ok: boolean; issues: SalesLinkageIssue[] } {
  const issues: SalesLinkageIssue[] = [];

  if (invoice.linkageStatus === 'unlinked') {
    issues.push({ code: 'NOT_LINKED', message: 'クラウド会計へ未連携です' });
  }
  if (invoice.linkageStatus === 'error') {
    issues.push({
      code: 'LINKAGE_ERROR',
      message: invoice.errorMessage || 'クラウド会計への連携でエラーが発生しています',
    });
  }
  if (!invoice.journalDate) {
    issues.push({ code: 'MISSING_JOURNAL_DATE', message: '売上計上日がありません' });
  }
  if (!Number.isFinite(invoice.totalAmount) || invoice.totalAmount <= 0) {
    issues.push({ code: 'INVALID_AMOUNT', message: '請求金額が正の数ではありません' });
  }
  if (
    policy.expectedDebitAccount &&
    invoice.debitAccount !== policy.expectedDebitAccount
  ) {
    issues.push({ code: 'ACCOUNT_MISMATCH', message: '借方科目がルールと一致しません' });
  }
  if (
    policy.expectedCreditAccount &&
    invoice.creditAccount !== policy.expectedCreditAccount
  ) {
    issues.push({ code: 'ACCOUNT_MISMATCH', message: '貸方科目がルールと一致しません' });
  }
  if (policy.expectedDepartment && invoice.department !== policy.expectedDepartment) {
    issues.push({ code: 'DEPARTMENT_MISMATCH', message: '部門がルールと一致しません' });
  }
  if (policy.expectedTaxCategory && invoice.taxCategory !== policy.expectedTaxCategory) {
    issues.push({ code: 'TAX_CATEGORY_MISMATCH', message: '税区分がルールと一致しません' });
  }

  return { ok: issues.length === 0, issues };
}

