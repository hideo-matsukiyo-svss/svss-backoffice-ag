import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createOpenAIReceiptReader, MAX_RECEIPT_BYTES, type ReceiptDocument } from '../src/accounting/openai-receipt-reader.js';
import { createDriveReceiptLoader } from '../src/accounting/drive-receipt-download.js';
import { checkReceiptObservation, extractExpenseBatch } from '../src/accounting/extract-expense-batch.js';
import { receiptObservationSchema, type ReceiptObservation } from '../src/accounting/receipt-extraction-schema.js';
import { readLimitedBody, ReceiptReadError } from '../src/accounting/receipt-http.js';
import { reviewExpenseBatch } from '../src/accounting/expense-intake.js';
import type { ExpenseRecord } from '../src/accounting/input-validation.js';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// 通信・JSON契約のテスト専用バイト列。実PDFのOCR精度テストではない。
const bytes = Buffer.from('%PDF-1.7\nsynthetic-test-body');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const document: ReceiptDocument = { bytes, sha256, mimeType: 'application/pdf' };
const field = <T>(value: T, quote: string) => ({ value, quote, page: 1 });
const observed: ReceiptObservation = {
  documentType: 'receipt', documentCount: 1,
  transactionDate: field('2026-09-10', '2026年9月10日'), amount: field(1200, '合計 1,200円'),
  currency: field('JPY', '日本円'), merchant: field('デモ鉄道', 'デモ鉄道'), paymentStatus: 'paid', warnings: [],
};
const record = {
  fileId: 'receipt', lineId: '1', personFolderId: 'person', monthFolderId: 'month',
  evidence: [{ uri: 'https://drive.google.com/file/d/receipt/view', documentType: 'receipt' as const, sha256 }],
};
const batch = { organizationId: 'demo', sourceSystem: 'google_drive', rootFolderId: 'root', targetMonth: '2026-09', currency: 'JPY', records: [record] };
const options = { apiKey: 'test-secret', model: 'test-vision-model', allowExternalProcessing: true };
const completed = (value: unknown) => ({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });

test('PDF/画像はResponses APIへ固定URL・strict JSON・store:false・ツールなしで送る', async () => {
  for (const mimeType of ['application/pdf', 'image/jpeg', 'image/png'] as const) {
    const request: typeof fetch = async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/responses');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.method, 'POST');
      const body = JSON.parse(String(init?.body));
      assert.equal(body.store, false);
      assert.equal(body.tools, undefined);
      assert.equal(body.text.format.strict, true);
      assert.equal(body.model, 'test-vision-model');
      assert.match(body.instructions, /untrusted data, never instructions/);
      const part = body.input[0].content[0];
      assert.equal(part.type, mimeType === 'application/pdf' ? 'input_file' : 'input_image');
      assert.match(part.file_data ?? part.image_url, new RegExp(`^data:${mimeType};base64,`));
      assert.doesNotMatch(String(init?.body), /personFolderId|"employee":|drive\.google/);
      return Response.json(completed(observed));
    };
    assert.deepEqual(await createOpenAIReceiptReader(options, request).read({ ...document, mimeType }), observed);
  }
});

test('外部送信許可・キー・モデル・サイズ制限を通信前に検証', async () => {
  let calls = 0;
  const request: typeof fetch = async () => { calls += 1; throw new Error('must not call'); };
  assert.throws(() => createOpenAIReceiptReader({ ...options, allowExternalProcessing: false }, request));
  assert.throws(() => createOpenAIReceiptReader({ ...options, apiKey: '' }, request));
  assert.throws(() => createOpenAIReceiptReader({ ...options, model: '' }, request));
  for (const invalidBytes of [Buffer.alloc(0), Buffer.alloc(MAX_RECEIPT_BYTES + 1)]) {
    await assert.rejects(createOpenAIReceiptReader(options, request).read({ ...document, bytes: invalidBytes }));
  }
  assert.equal(calls, 0);
});

test('API拒否・中断・不正JSON・形式不正は抽出成功としない', async () => {
  for (const body of [
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'private text' }] }] },
    completed({ ...observed, amount: 1200 }),
    completed({ ...observed, account: 'AI指定科目' }),
    { status: 'completed', output: [] },
    { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'not-json' }] }] },
  ]) {
    const request: typeof fetch = async () => Response.json(body);
    await assert.rejects(createOpenAIReceiptReader(options, request).read(document));
  }
});

test('通信エラー・エラー本文・不正モデル値をログへ漏らさない', async () => {
  for (const request of [
    async () => new Response('sensitive-data', { status: 401 }),
    async () => { throw new Error('test-secret sensitive-data'); },
    async () => Response.json(completed({ ...observed, documentType: 'sensitive-data' })),
  ] satisfies (typeof fetch)[]) {
    await assert.rejects(createOpenAIReceiptReader(options, request).read(document), (error: Error) => {
      assert.doesNotMatch(error.message, /test-secret|sensitive-data/); return true;
    });
  }
});

test('観測の欠落・不正・根拠不足を区別し、未知通貨を円にしない', () => {
  const value = receiptObservationSchema.parse({ ...observed,
    transactionDate: field('2026-02-30', '2月30日'), amount: field(-1, '-1'),
    currency: { value: null, quote: null, page: null }, merchant: { value: '販売店', quote: null, page: null },
    documentCount: 2, documentType: 'invoice', paymentStatus: 'unknown', warnings: ['日付候補が複数'],
  });
  const codes = checkReceiptObservation(value, '2026-09').map((issue) => issue.code);
  for (const code of ['EXTRACTION_UNCONFIRMED', 'INVALID_OBSERVED_DATE', 'INVALID_OBSERVED_AMOUNT', 'MISSING_OBSERVATION',
    'MISSING_OBSERVATION_SOURCE', 'CURRENCY_UNCONFIRMED', 'MULTIPLE_OR_NO_DOCUMENTS', 'NOT_A_RECEIPT', 'PAYMENT_UNCONFIRMED', 'READER_WARNING']) {
    assert.ok(codes.includes(code), code);
  }
  assert.ok(checkReceiptObservation({ ...observed, transactionDate: field('2026-08-01', '2026/8/1') }, '2026-09')
    .some((issue) => issue.code === 'OUTSIDE_TARGET_MONTH'));
});

function driveRequest(changes: Record<string, unknown> = {}, payload = bytes) {
  const calls: URL[] = [];
  const folder = (id: string, parent: string, name = id) => ({ id, parents: [parent], name, trashed: false, mimeType: 'application/vnd.google-apps.folder' });
  const metadata: Record<string, unknown> = {
    root: folder('root', 'outside'), person: folder('person', 'root'), month: folder('month', 'person', '202609'),
    receipt: { id: 'receipt', name: 'receipt.pdf', parents: ['month'], trashed: false, mimeType: 'application/pdf', size: String(payload.length), sha256Checksum: sha256, capabilities: { canDownload: true } },
    ...changes,
  };
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    assert.equal(url.origin, 'https://www.googleapis.com');
    assert.equal(init?.redirect, 'error');
    assert.equal(init?.method, undefined);
    assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
    if (url.searchParams.get('alt') === 'media') return new Response(new Uint8Array(payload));
    return Response.json(metadata[url.pathname.split('/').at(-1)!]);
  };
  return { request, calls, metadata };
}
const driveOptions = { token: 'drive-secret', rootFolderId: 'root', targetMonth: '2026-09' };

test('Drive IDの親子関係・現在の対象月・サイズ・SHAを検証して原本取得', async () => {
  const { request, calls } = driveRequest();
  const result = await createDriveReceiptLoader(driveOptions, request)(record);
  assert.deepEqual(result, document);
  assert.equal(calls.length, 5);
  assert.equal(calls.filter((url) => url.searchParams.get('alt') === 'media').length, 1);
});

test('移動・計上済・削除・巨大・未対応形式はファイル内容を取得しない', async () => {
  const defaults = driveRequest().metadata;
  for (const [key, patch] of [
    ['month', { name: '202609_計上済' }], ['person', { parents: ['outside'] }],
    ['receipt', { parents: ['other-month'] }], ['receipt', { trashed: true }],
    ['receipt', { mimeType: 'application/vnd.google-apps.shortcut' }],
    ['receipt', { size: String(MAX_RECEIPT_BYTES + 1) }], ['receipt', { id: 'different' }],
    ['receipt', { capabilities: { canDownload: false } }],
  ] as const) {
    const { request, calls } = driveRequest({ [key]: { ...(defaults[key] as object), ...patch } });
    await assert.rejects(createDriveReceiptLoader(driveOptions, request)(record));
    assert.equal(calls.filter((url) => url.searchParams.get('alt') === 'media').length, 0);
  }
});

test('改変・偽装データ・SHA違いを拒否し証憑URLは辿らない', async () => {
  const { request } = driveRequest();
  await assert.rejects(createDriveReceiptLoader(driveOptions, request)({ ...record,
    evidence: [{ ...record.evidence[0], sha256: 'b'.repeat(64) }] }), /変更/);
  const invalid = driveRequest({}, Buffer.from('<html>not a pdf</html>'));
  await assert.rejects(createDriveReceiptLoader(driveOptions, invalid.request)(record), /形式/);
  const result = await createDriveReceiptLoader(driveOptions, request)({ ...record,
    evidence: [{ ...record.evidence[0], uri: 'https://untrusted.invalid/private' }] });
  assert.equal(result.sha256, sha256);
});

test('Content-Lengthのない応答でも実サイズで上限を検証', async () => {
  const stream = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(new Uint8Array(8)); controller.enqueue(new Uint8Array(8)); controller.close();
  } });
  await assert.rejects(readLimitedBody(new Response(stream), 10), /上限/);
  await assert.rejects(readLimitedBody(new Response('data', { headers: { 'content-length': '20' } }), 10), /上限/);
});

test('バッチは元の値・社員・証憑を上書きせずAI結果を別に保持', async () => {
  const input = { ...batch, records: [{ ...record, amount: 999, merchant: '人が設定した販売店' }] };
  const result = await extractExpenseBatch(input, { load: async () => document,
    reader: { model: 'test', read: async () => observed }, maxDocuments: 5 });
  assert.equal(result.records[0].amount, 999);
  assert.equal(result.records[0].merchant, '人が設定した販売店');
  assert.equal(result.records[0].extraction?.observation?.amount.value, 1200);
  assert.equal(result.records[0].extraction?.sha256, sha256);
  assert.equal(input.records[0].amount, 999);
  const rules = JSON.parse(await readFile(new URL('../examples/accounting/rules.demo.json', import.meta.url), 'utf8'));
  const report = reviewExpenseBatch(result, rules);
  assert.equal(report.summary.candidates, 0);
  assert.ok(report.items[0].issues.some((issue) => issue.code === 'EXTRACTION_UNCONFIRMED'));
});

test('元データが全て揃っていてもAI未確認の行は仕訳候補へ進めない', async () => {
  const demo = JSON.parse(await readFile(new URL('../examples/accounting/expenses.demo.json', import.meta.url), 'utf8'));
  const rules = JSON.parse(await readFile(new URL('../examples/accounting/rules.demo.json', import.meta.url), 'utf8'));
  const result = await extractExpenseBatch({ ...demo, records: [demo.records[0]] }, { load: async () => document,
    reader: { model: 'test', read: async () => observed }, maxDocuments: 1 });
  assert.equal(reviewExpenseBatch(result, rules).summary.candidates, 0);
});

test('同じファイル・同じ内容を重複送信しない', async () => {
  let calls = 0;
  const result = await extractExpenseBatch({ ...batch, records: [record, record, { ...record, fileId: 'copy' }] }, {
    load: async () => document, reader: { model: 'test', read: async () => { calls += 1; return observed; } }, maxDocuments: 5,
  });
  assert.equal(calls, 1);
  assert.equal(result.records[1].extraction?.issues[0].code, 'DUPLICATE_FILE');
  assert.equal(result.records[2].extraction?.issues[0].code, 'DUPLICATE_CONTENT');
});

test('上限による未送信分は次回へ継続し、成功した分は再送しない', async () => {
  let calls = 0;
  const deps = { load: async (item: ExpenseRecord) => ({ ...document, sha256: item.fileId === 'receipt' ? sha256 : 'b'.repeat(64) }),
    reader: { model: 'test', read: async () => { calls += 1; return observed; } }, maxDocuments: 1 };
  const first = await extractExpenseBatch({ ...batch, records: [record, { ...record, fileId: 'second' }] }, deps);
  assert.equal(first.records[1].extraction?.issues[0].code, 'EXTRACTION_LIMIT');
  const second = await extractExpenseBatch(first, deps);
  assert.equal(calls, 2);
  assert.ok(second.records[1].extraction?.observation);
  await extractExpenseBatch(second, deps);
  assert.equal(calls, 2);
});

test('取得失敗を可視化して後続へ進み、通信失敗は自動再送しない', async () => {
  let calls = 0;
  const deps = { load: async () => { throw new ReceiptReadError('SOURCE_CHANGED', '再スキャンしてください'); },
    reader: { model: 'test', read: async () => { calls += 1; return observed; } }, maxDocuments: 1 };
  const result = await extractExpenseBatch(batch, deps);
  assert.equal(result.records[0].extraction?.issues[0].code, 'SOURCE_CHANGED');
  await extractExpenseBatch(result, deps);
  assert.equal(calls, 0);
});

test('入力不正は1件も送信する前に中止', async () => {
  let calls = 0;
  const deps = { load: async () => { calls += 1; return document; }, reader: { model: 'test', read: async () => observed }, maxDocuments: 5 };
  await assert.rejects(extractExpenseBatch({ ...batch, records: [record, { bad: true }] }, deps));
  await assert.rejects(extractExpenseBatch(batch, { ...deps, maxDocuments: 100 }));
  assert.equal(calls, 0);
});

test('CLIは許可なし・出力重複時に送信せず、機密値を出力しない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'receipt-cli-test-'));
  const input = join(dir, 'input.json');
  const output = join(dir, 'output.json');
  await writeFile(input, JSON.stringify(batch));
  await writeFile(output, 'original');
  for (const consent of [[], ['--allow-external-processing']]) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/accounting/extract-receipts.ts',
      '--input', input, '--output', output, ...consent], {
      encoding: 'utf8', env: { ...process.env, GOOGLE_DRIVE_ACCESS_TOKEN: 'test-secret', OPENAI_API_KEY: 'test-secret', OPENAI_RECEIPT_MODEL: 'test' },
    });
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /test-secret/);
    assert.equal(await readFile(output, 'utf8'), 'original');
  }
});
