export type AccountingSourceType =
  | 'moneyforward_cloud_invoice'
  | 'expense_reimbursement'
  | 'vendor_invoice_email';

export type ApprovalStatus = 'draft' | 'needs_review' | 'approved' | 'exported';

export type JournalSide = {
  account: string;
  subAccount?: string;
  department?: string;
  counterparty?: string;
  taxCategory?: string;
  invoiceClassification?: string;
  amount: number;
};

export type EvidenceReference = {
  uri: string;
  sha256?: string;
  documentType: 'invoice' | 'receipt' | 'application' | 'other';
};

/**
 * 立替経費と受領請求書を、MF形式へ変換する前に正規化した仕訳候補。
 * 売上はMFクラウド請求書の標準連携を使うため、CSV出力対象にはしない。
 */
export type JournalCandidate = {
  idempotencyKey: string;
  sourceType: AccountingSourceType;
  sourceId: string;
  lineNumber: number;
  fiscalPeriod: string;
  transactionDate: string;
  debit: JournalSide;
  credit: JournalSide;
  description: string;
  memo?: string;
  tags?: string[];
  evidence: EvidenceReference[];
  approvalStatus: ApprovalStatus;
};

