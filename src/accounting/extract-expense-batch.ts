import { expenseBatchSchema, expenseRecordSchema, isCalendarDate } from './input-validation.js';
import { receiptObservationSchema, type ReceiptExtraction, type ReceiptObservation } from './receipt-extraction-schema.js';
import type { ReceiptLoader } from './drive-receipt-download.js';
import type { ReceiptReader } from './openai-receipt-reader.js';
import { ReceiptReadError } from './receipt-http.js';

export function checkReceiptObservation(observation: ReceiptObservation, targetMonth: string): ReceiptExtraction['issues'] {
  const issues: ReceiptExtraction['issues'] = [{ code: 'EXTRACTION_UNCONFIRMED', message: '読取候補を原本と照合してください（経費申請の承認ではありません）' }];
  const flag = (code: string, message: string) => issues.push({ code, message });
  if (observation.documentCount !== 1) flag('MULTIPLE_OR_NO_DOCUMENTS', '証憑が1件ではありません。分割または内容確認が必要です');
  if (observation.documentType !== 'receipt') flag('NOT_A_RECEIPT', '領収書以外です。立替済みの証憑か確認してください');
  if (observation.paymentStatus !== 'paid') flag('PAYMENT_UNCONFIRMED', '支払済みと確認できません');
  for (const name of ['transactionDate', 'amount', 'currency', 'merchant'] as const) {
    const field = observation[name];
    if (field.value === null) flag('MISSING_OBSERVATION', `${name}: 読取不能または不明です`);
    else if (!field.quote || !field.page) flag('MISSING_OBSERVATION_SOURCE', `${name}: 根拠文言・ページがありません`);
  }
  const date = observation.transactionDate.value;
  if (date !== null && !isCalendarDate(date)) flag('INVALID_OBSERVED_DATE', '取引日の形式または日付が不正です');
  else if (date && date.slice(0, 7) !== targetMonth) flag('OUTSIDE_TARGET_MONTH', '読取日付が対象月外です');
  const amount = observation.amount.value;
  if (amount !== null && (!Number.isSafeInteger(amount) || amount <= 0)) flag('INVALID_OBSERVED_AMOUNT', '金額が正の整数円ではありません');
  if (observation.currency.value !== 'JPY') flag('CURRENCY_UNCONFIRMED', '日本円と確認できません。通貨換算はしません');
  if (observation.warnings.length) flag('READER_WARNING', '読取時の注意事項があります。extraction.observation.warningsを確認してください');
  return issues;
}

/** 原本取得とAI抽出を分離。抽出値をamount等へ自動転記しない。 */
export async function extractExpenseBatch(input: unknown, dependencies: {
  load: ReceiptLoader; reader: ReceiptReader; maxDocuments: number;
}) {
  const batch = expenseBatchSchema.parse(input);
  if (!Number.isSafeInteger(dependencies.maxDocuments) || dependencies.maxDocuments < 1 || dependencies.maxDocuments > 20) {
    throw new Error('1回の読取上限は1〜20件で指定してください');
  }
  const records = [];
  const seen = new Set<string>();
  const seenHashes = new Set<string>();
  let attempts = 0;
  // 入力が不正なまま一部だけ有料処理しない。
  const parsed = batch.records.map((record) => expenseRecordSchema.parse(record));
  for (const record of parsed) {
    // 上限による未送信行だけは次回へ継続する。成功・通信失敗を自動再送しない。
    if (record.extraction && !record.extraction.issues.every((issue) => issue.code === 'EXTRACTION_LIMIT')) {
      seen.add(record.fileId);
      if (record.extraction.sha256) seenHashes.add(record.extraction.sha256);
      records.push(record);
      continue;
    }
    const extraction: ReceiptExtraction = {
      status: 'needs_review', provider: 'openai', model: dependencies.reader.model, promptVersion: 'receipt-v1',
      issues: [],
    };
    if (seen.has(record.fileId)) {
      extraction.issues.push({ code: 'DUPLICATE_FILE', message: '同一ファイルを同じバッチで再送信しません' });
    } else if (attempts >= dependencies.maxDocuments) {
      extraction.issues.push({ code: 'EXTRACTION_LIMIT', message: '今回の読取件数上限に達しました。送信していません' });
    } else {
      seen.add(record.fileId);
      attempts += 1;
      try {
        const document = await dependencies.load(record);
        extraction.sha256 = document.sha256;
        if (seenHashes.has(document.sha256)) throw new ReceiptReadError('DUPLICATE_CONTENT', '同一内容の証憑をこのバッチで再送信しません');
        seenHashes.add(document.sha256);
        const observation = receiptObservationSchema.parse(await dependencies.reader.read(document));
        extraction.observation = observation;
        extraction.issues = checkReceiptObservation(observation, batch.targetMonth);
      } catch (error) {
        extraction.issues.push(error instanceof ReceiptReadError
          ? { code: error.code, message: error.message }
          : { code: 'RECEIPT_READ_FAILED', message: '証憑の取得または読取に失敗しました。原本と接続設定を確認してください' });
      }
    }
    records.push({ ...record, extraction });
  }
  return { ...batch, records };
}
