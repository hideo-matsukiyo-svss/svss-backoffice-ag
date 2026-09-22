import type { JournalCandidate, JournalSide } from './types.js';

export const MF_JOURNAL_HEADERS = [
  '取引No', '取引日', '借方勘定科目', '借方補助科目', '借方部門', '借方取引先',
  '借方税区分', '借方インボイス', '借方金額(円)', '借方税額', '貸方勘定科目',
  '貸方補助科目', '貸方部門', '貸方取引先', '貸方税区分', '貸方インボイス',
  '貸方金額(円)', '貸方税額', '摘要', '仕訳メモ', 'タグ', 'MF仕訳タイプ',
  '決算整理仕訳', '作成日時', '作成者', '最終更新日時', '最終更新者',
] as const;

function csvCell(value: string | number | undefined): string {
  const text = value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function sideCells(side: JournalSide): Array<string | number | undefined> {
  return [
    side.account,
    side.subAccount,
    side.department,
    side.counterparty,
    side.taxCategory,
    side.invoiceClassification,
    side.amount,
    '',
  ];
}

function formatDate(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`取引日はYYYY-MM-DD形式で指定してください: ${date}`);
  }
  return date.replaceAll('-', '/');
}

function validateCandidate(candidate: JournalCandidate): void {
  if (candidate.sourceType === 'moneyforward_cloud_invoice') {
    throw new Error('売上はMFクラウド請求書の標準連携を使うためCSV出力できません');
  }
  if (candidate.approvalStatus !== 'approved') {
    throw new Error(`未承認の仕訳候補は出力できません: ${candidate.idempotencyKey}`);
  }
  if (candidate.debit.amount !== candidate.credit.amount) {
    throw new Error(`貸借金額が一致しません: ${candidate.idempotencyKey}`);
  }
  if (!Number.isInteger(candidate.debit.amount) || candidate.debit.amount <= 0) {
    throw new Error(`金額は正の整数で指定してください: ${candidate.idempotencyKey}`);
  }
}

export function toMoneyForwardJournalCsv(
  candidates: JournalCandidate[],
  transactionNumberStart = 1,
): string {
  const rows = candidates.map((candidate, index) => {
    validateCandidate(candidate);
    const values: Array<string | number | undefined> = [
      transactionNumberStart + index,
      formatDate(candidate.transactionDate),
      ...sideCells(candidate.debit),
      ...sideCells(candidate.credit),
      candidate.description,
      candidate.memo,
      candidate.tags?.join('|'),
      'インポート',
      '', '', '', '', '',
    ];
    return values.map(csvCell).join(',');
  });

  return [MF_JOURNAL_HEADERS.join(','), ...rows].join('\r\n') + '\r\n';
}

