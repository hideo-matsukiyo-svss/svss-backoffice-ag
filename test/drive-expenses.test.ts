import assert from 'node:assert/strict';
import test from 'node:test';
import { createDriveReader, scanDriveExpenses, type DriveFile, type DriveReader } from '../src/accounting/drive-expenses.js';
import { reviewExpenseBatch } from '../src/accounting/expense-intake.js';

const folder = (id: string, name = id): DriveFile => ({ id, name, mimeType: 'application/vnd.google-apps.folder' });
const pdf = (id: string): DriveFile => ({ id, name: `${id}.pdf`, mimeType: 'application/pdf', sha256Checksum: 'a'.repeat(64) });
const config = { organizationId: 'demo', rootFolderId: 'root', targetMonth: '2026-09', people: [{
  folderId: 'person', employee: { id: 'employee', name: 'デモ社員', accountingCounterparty: 'デモMF社員' }, department: 'デモ部門',
}] };
function mockTree(tree: Record<string, DriveFile[]>) {
  const visited: string[] = [];
  const reader: DriveReader = {
    async getFolder(id) { return { ...folder(id), driveId: 'shared-drive' }; },
    async listChildren(id, drive) {
      assert.equal(drive, 'shared-drive'); visited.push(id); return tree[id] ?? [];
    },
  };
  return { reader, visited };
}

test('人別→YYYYMMを列挙し、名前でなくIDから社員を紐づける', async () => {
  const { reader, visited } = mockTree({ root: [folder('person', '改名後の氏名')],
    person: [folder('old', '202608_計上済'), folder('month', '202609')], month: [pdf('receipt')] });
  const result = await scanDriveExpenses(reader, config);
  assert.equal(result.batch.records.length, 1);
  assert.equal(result.batch.records[0].employee?.id, 'employee');
  assert.equal(result.batch.records[0].amount, undefined);
  assert.deepEqual(visited, ['root', 'person', 'month']);
  const report = reviewExpenseBatch({ ...result.batch, scanNotices: result.notices }, {
    version: 'empty', requireEvidence: true, requireDepartment: true, rules: [],
  });
  assert.equal(report.summary.needsReview, 1);
});

test('計上済フォルダは開かず、未計上と混在していても同月全体を除外', async () => {
  const { reader, visited } = mockTree({ root: [folder('person')], person: [
    folder('posted', '202609_計上済'), folder('unposted', '202609'),
  ] });
  const result = await scanDriveExpenses(reader, config);
  assert.equal(result.batch.records.length, 0);
  assert.ok(result.notices.some((notice) => notice.code === 'ALREADY_POSTED'));
  assert.ok(result.notices.some((notice) => notice.code === 'MONTH_STATE_CONFLICT'));
  assert.deepEqual(visited, ['root', 'person']);
});

test('同名月フォルダ・月なし・想定外配置を通知し取り込まない', async () => {
  const { reader } = mockTree({ root: [folder('person'), folder('other-person'), pdf('root-file')], person: [
    folder('month1', '202609'), folder('month2', '202609'), folder('odd', '９月'),
  ] });
  const result = await scanDriveExpenses(reader, config);
  for (const code of ['DUPLICATE_MONTH_FOLDER', 'NO_TARGET_MONTH', 'UNEXPECTED_ROOT_FILE', 'UNEXPECTED_MONTH_ITEM', 'UNMAPPED_PERSON']) {
    assert.ok(result.notices.some((notice) => notice.code === code), code);
  }
  assert.equal(result.batch.records.length, 0);
});

test('未設定社員の証憑も確認対象に残し、ショートカット・深い階層は追わない', async () => {
  const { reader, visited } = mockTree({ root: [folder('person')], person: [folder('month', '202609')], month: [
    pdf('receipt'), folder('nested'), { id: 'shortcut', name: '外部', mimeType: 'application/vnd.google-apps.shortcut' },
  ] });
  const result = await scanDriveExpenses(reader, { ...config, people: [] });
  assert.equal(result.batch.records[0].employee, undefined);
  assert.equal(result.notices.filter((notice) => notice.code === 'UNSUPPORTED_FILE').length, 2);
  assert.deepEqual(visited, ['root', 'person', 'month']);
});

test('Drive RESTのページング・共有ドライブ・読取専用フラグ', async () => {
  const urls: URL[] = [];
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input)); urls.push(url);
    assert.equal(init?.method, undefined);
    assert.equal(init?.redirect, 'error');
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer test-token');
    if (url.pathname.endsWith('/root')) return Response.json({ ...folder('root'), driveId: 'shared' });
    if (!url.searchParams.has('pageToken')) return Response.json({ files: [], nextPageToken: 'page-2' });
    return Response.json({ files: [pdf('receipt')] });
  };
  const reader = createDriveReader('test-token', request);
  assert.equal((await reader.getFolder('root')).driveId, 'shared');
  assert.equal((await reader.listChildren('month', 'shared')).length, 1);
  assert.equal(urls.length, 3);
  for (const url of urls.slice(1)) {
    assert.equal(url.searchParams.get('corpora'), 'drive');
    assert.equal(url.searchParams.get('driveId'), 'shared');
    assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
    assert.equal(url.searchParams.get('includeItemsFromAllDrives'), 'true');
    assert.equal(url.searchParams.get('q'), "'month' in parents and trashed = false");
  }
  assert.equal(urls[2].searchParams.get('pageToken'), 'page-2');
});

test('APIの不完全検索・ページループ・権限エラー・不正応答で中止', async () => {
  for (const body of [
    { files: [], incompleteSearch: true }, { files: [], nextPageToken: 'same' },
    { files: [{ id: 'bad' }] },
  ]) {
    const request: typeof fetch = async () => Response.json(body);
    await assert.rejects(createDriveReader('token', request).listChildren('month'));
  }
  const request: typeof fetch = async () => new Response('private-response-secret', { status: 403 });
  await assert.rejects(createDriveReader('secret-token', request).listChildren('month'), (error: Error) => {
    assert.match(error.message, /403/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  assert.throws(() => createDriveReader(''));
  await assert.rejects(createDriveReader('token', request).listChildren("bad'id"));
});

test('削除済み・非フォルダをルートに使わない', async () => {
  for (const body of [pdf('root'), { ...folder('root'), trashed: true }]) {
    const request: typeof fetch = async () => Response.json(body);
    await assert.rejects(createDriveReader('token', request).getFolder('root'));
  }
});

test('不正設定はDriveを読む前に拒否する', async () => {
  const { reader, visited } = mockTree({});
  await assert.rejects(scanDriveExpenses(reader, { ...config, people: [...config.people, ...config.people] }));
  await assert.rejects(scanDriveExpenses(reader, { ...config, rootFolderId: "unsafe'query" }));
  assert.equal(visited.length, 0);
});
