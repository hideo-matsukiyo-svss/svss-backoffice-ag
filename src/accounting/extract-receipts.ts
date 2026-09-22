import { readFile, mkdir, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { expenseBatchSchema, expenseRecordSchema } from './input-validation.js';
import { createOpenAIReceiptReader } from './openai-receipt-reader.js';
import { createDriveReceiptLoader } from './drive-receipt-download.js';
import { extractExpenseBatch } from './extract-expense-batch.js';

async function main() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' }, output: { type: 'string' },
      'allow-external-processing': { type: 'boolean', default: false },
      'max-documents': { type: 'string', default: '5' },
    }, strict: true, allowPositionals: false,
  });
  if (!values.input || !values.output) throw new Error('使用方法: npm run accounting:extract -- --input .data/scan.json --output .data/extracted.json --allow-external-processing [--max-documents 5]');
  const batch = expenseBatchSchema.parse(JSON.parse(await readFile(resolve(values.input), 'utf8')));
  batch.records.forEach((record) => expenseRecordSchema.parse(record));
  if (!batch.rootFolderId) throw new Error('取込元のrootFolderIdがありません');
  const maxDocuments = Number(values['max-documents']);
  if (!Number.isSafeInteger(maxDocuments) || maxDocuments < 1 || maxDocuments > 20) throw new Error('読取上限は1〜20件です');
  const reader = createOpenAIReceiptReader({
    apiKey: process.env.OPENAI_API_KEY ?? '', model: process.env.OPENAI_RECEIPT_MODEL ?? '',
    allowExternalProcessing: values['allow-external-processing'],
  });
  const load = createDriveReceiptLoader({ token: process.env.GOOGLE_DRIVE_ACCESS_TOKEN ?? '',
    rootFolderId: batch.rootFolderId, targetMonth: batch.targetMonth });
  const destination = resolve(values.output);
  await mkdir(dirname(destination), { recursive: true });
  // 有料API呼出しより先に出力先を確保し、上書きや無駄な再送を防ぐ。
  const output = await open(destination, 'wx', 0o600);
  try {
    const result = await extractExpenseBatch(batch, { load, reader, maxDocuments });
    await output.writeFile(JSON.stringify(result, null, 2) + '\n');
    const extracted = result.records.filter((record) => record.extraction?.observation).length;
    console.log(`読取レポート: ${destination} / 全${result.records.length}件 / 読取候補${extracted}件（未確定）`);
  } finally { await output.close(); }
}

main().catch(() => {
  // Zodエラーや外部応答には私有情報が含まれうるため、CLIでは値を出さない。
  console.error('読取中止: 入力形式、外部送信許可、API設定、件数上限、出力先の重複を確認してください。');
  process.exitCode = 1;
});
