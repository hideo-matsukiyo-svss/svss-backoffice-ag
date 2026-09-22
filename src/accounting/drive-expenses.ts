import { z } from 'zod';
import { expenseRecordSchema, type ExpenseRecord } from './input-validation.js';

const folderMime = 'application/vnd.google-apps.folder';
const driveId = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const label = z.string().trim().min(1);
const fileSchema = z.object({
  id: driveId, name: label, mimeType: label, driveId: driveId.optional(),
  sha256Checksum: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  trashed: z.boolean().optional(),
});
export type DriveFile = z.infer<typeof fileSchema>;
export type DriveReader = {
  getFolder(id: string): Promise<DriveFile>;
  listChildren(id: string, sharedDriveId?: string): Promise<DriveFile[]>;
};

/** 読取専用。レスポンス本文やトークンをエラーメッセージへ出さない。 */
export function createDriveReader(token: string, request: typeof fetch = fetch): DriveReader {
  if (!token.trim()) throw new Error('GOOGLE_DRIVE_ACCESS_TOKENが未設定です');
  async function get(url: URL): Promise<unknown> {
    const response = await request(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000), redirect: 'error',
    });
    if (!response.ok) throw new Error(`Drive読取に失敗しました（HTTP ${response.status}）`);
    return response.json();
  }
  return {
    async getFolder(id) {
      driveId.parse(id);
      const url = new URL(`https://www.googleapis.com/drive/v3/files/${id}`);
      url.search = new URLSearchParams({
        fields: 'id,name,mimeType,driveId,trashed', supportsAllDrives: 'true',
      }).toString();
      const folder = fileSchema.parse(await get(url));
      if (folder.mimeType !== folderMime || folder.trashed) throw new Error('有効なフォルダではありません');
      return folder;
    },
    async listChildren(id, sharedDriveId) {
      driveId.parse(id);
      if (sharedDriveId) driveId.parse(sharedDriveId);
      const files = new Map<string, DriveFile>();
      const seenTokens = new Set<string>();
      let pageToken: string | undefined;
      do {
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        url.search = new URLSearchParams({
          q: `'${id}' in parents and trashed = false`,
          fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,sha256Checksum)',
          pageSize: '1000', spaces: 'drive', supportsAllDrives: 'true',
          includeItemsFromAllDrives: 'true', corpora: sharedDriveId ? 'drive' : 'user',
          ...(sharedDriveId ? { driveId: sharedDriveId } : {}),
          ...(pageToken ? { pageToken } : {}),
        }).toString();
        const page = z.object({
          files: z.array(fileSchema), nextPageToken: label.optional(),
          incompleteSearch: z.boolean().optional(),
        }).parse(await get(url));
        if (page.incompleteSearch) throw new Error('Drive検索が不完全なため取込を中止しました');
        for (const file of page.files) files.set(file.id, file);
        if (files.size > 10000) throw new Error('1フォルダの取込上限（10000件）を超えています');
        pageToken = page.nextPageToken;
        if (pageToken) {
          if (seenTokens.has(pageToken) || seenTokens.size >= 100) throw new Error('Driveページング異常');
          seenTokens.add(pageToken);
        }
      } while (pageToken);
      return [...files.values()].sort((a, b) => a.id.localeCompare(b.id));
    },
  };
}

export const driveExpenseConfigSchema = z.object({
  organizationId: label,
  rootFolderId: driveId,
  targetMonth: label.regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/),
  people: z.array(z.object({
    folderId: driveId,
    employee: expenseRecordSchema.shape.employee.unwrap(),
    department: label.max(20),
  }).strict()),
}).strict().superRefine((config, context) => {
  const ids = config.people.map((person) => person.folderId);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: 'custom', message: '人別フォルダIDが重複しています' });
});

export type ScanNotice = { code: string; fileId: string; message: string };
export type DriveExpenseScan = {
  batch: {
    organizationId: string; sourceSystem: 'google_drive'; rootFolderId: string;
    targetMonth: string; currency: 'JPY'; records: ExpenseRecord[];
  };
  notices: ScanNotice[];
};

/** 人別→YYYYMMの2階層のみ。既計上フォルダ・ショートカットは追跡しない。 */
export async function scanDriveExpenses(reader: DriveReader, input: unknown): Promise<DriveExpenseScan> {
  const config = driveExpenseConfigSchema.parse(input);
  const root = await reader.getFolder(config.rootFolderId);
  const children = (id: string) => reader.listChildren(id, root.driveId);
  const records: ExpenseRecord[] = [];
  const notices: ScanNotice[] = [];
  const note = (code: string, fileId: string, message: string) => notices.push({ code, fileId, message });
  const monthName = config.targetMonth.replace('-', '');
  for (const person of await children(root.id)) {
    if (person.mimeType !== folderMime) {
      note('UNEXPECTED_ROOT_FILE', person.id, '人別フォルダ以外は取り込みません');
      continue;
    }
    const mapping = config.people.find((entry) => entry.folderId === person.id);
    if (!mapping) note('UNMAPPED_PERSON', person.id, '人別フォルダと社員・MF取引先・部門の対応が未設定です');
    const months = await children(person.id);
    for (const item of months) {
      if (item.mimeType !== folderMime || !/^\d{4}(0[1-9]|1[0-2])(_計上済)?$/.test(item.name)) {
        note('UNEXPECTED_MONTH_ITEM', item.id, 'YYYYMM または YYYYMM_計上済 以外は取り込みません');
      }
    }
    const posted = months.filter((item) => item.mimeType === folderMime && item.name === `${monthName}_計上済`);
    const targets = months.filter((item) => item.mimeType === folderMime && item.name === monthName);
    if (posted.length) {
      for (const item of posted) note('ALREADY_POSTED', item.id, '計上済の印があるため、同じ人の対象月全体を除外しました');
      if (targets.length) note('MONTH_STATE_CONFLICT', person.id, '対象月に未計上・計上済フォルダが混在しています');
      continue;
    }
    if (targets.length !== 1) {
      note(targets.length ? 'DUPLICATE_MONTH_FOLDER' : 'NO_TARGET_MONTH', person.id,
        targets.length ? '対象月の同名フォルダが複数あり、取り込みません' : '対象月フォルダがありません');
      continue;
    }
    const month = targets[0];
    const files = await children(month.id);
    if (!files.length) note('EMPTY_MONTH', month.id, '対象月フォルダは空です');
    for (const file of files) {
      if (!['application/pdf', 'image/jpeg', 'image/png'].includes(file.mimeType)) {
        note('UNSUPPORTED_FILE', file.id, 'PDF・JPEG・PNG以外、サブフォルダ、ショートカットは取り込みません');
        continue;
      }
      records.push(expenseRecordSchema.parse({
        fileId: file.id, fileName: file.name, lineId: '1',
        personFolderId: person.id, personFolderName: person.name, monthFolderId: month.id,
        employee: mapping?.employee, department: mapping?.department,
        evidence: [{
          uri: `https://drive.google.com/file/d/${file.id}/view`,
          sha256: file.sha256Checksum, documentType: 'receipt',
        }],
      }));
      if (records.length > 10000) throw new Error('バッチの取込上限（10000件）を超えています');
    }
  }
  return {
    batch: { organizationId: config.organizationId, sourceSystem: 'google_drive',
      rootFolderId: root.id, targetMonth: config.targetMonth, currency: 'JPY', records },
    notices,
  };
}
