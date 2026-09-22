import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ExpenseRecord } from './input-validation.js';
import { MAX_RECEIPT_BYTES, type ReceiptDocument } from './openai-receipt-reader.js';
import { readLimitedBody, ReceiptReadError } from './receipt-http.js';

const id = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const folderMime = 'application/vnd.google-apps.folder';
const metadataSchema = z.object({
  id, name: z.string(), mimeType: z.string(), parents: z.array(id),
  trashed: z.boolean(), size: z.string().optional(), sha256Checksum: z.string().optional(),
  capabilities: z.object({ canDownload: z.boolean().optional() }).optional(),
});
export type ReceiptLoader = (record: ExpenseRecord) => Promise<ReceiptDocument>;

export function createDriveReceiptLoader(options: {
  token: string; rootFolderId: string; targetMonth: string;
}, request: typeof fetch = fetch): ReceiptLoader {
  id.parse(options.rootFolderId);
  if (!options.token.trim()) throw new ReceiptReadError('MISSING_DRIVE_CONFIG', 'GOOGLE_DRIVE_ACCESS_TOKENを設定してください');
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(options.targetMonth)) throw new Error('対象月が不正です');
  async function get(fileId: string, media = false) {
    id.parse(fileId);
    const url = new URL(`https://www.googleapis.com/drive/v3/files/${fileId}`);
    url.search = new URLSearchParams(media ? { alt: 'media', supportsAllDrives: 'true' } : {
      fields: 'id,name,mimeType,parents,trashed,size,sha256Checksum,capabilities(canDownload)', supportsAllDrives: 'true',
    }).toString();
    const response = await request(url, { headers: { Authorization: `Bearer ${options.token}` },
      signal: AbortSignal.timeout(30_000), redirect: 'error' });
    return readLimitedBody(response, media ? MAX_RECEIPT_BYTES : 64 * 1024);
  }
  const metadata = async (fileId: string) => {
    const file = metadataSchema.parse(JSON.parse((await get(fileId)).toString('utf8')));
    if (file.id !== fileId) throw new ReceiptReadError('INVALID_METADATA', 'DriveのファイルIDが一致しません');
    return file;
  };
  return async (record) => {
    if (!record.personFolderId || !record.monthFolderId) throw new ReceiptReadError('MISSING_FOLDER_ID', '証憑の人別・月別フォルダIDがありません');
    // URLは一切辿らず、Drive IDと現在の親子関係を照合する。
    const [root, person, month, file] = await Promise.all([
      metadata(options.rootFolderId), metadata(record.personFolderId), metadata(record.monthFolderId), metadata(record.fileId),
    ]);
    if ([root, person, month, file].some((item) => item.trashed)
      || [root, person, month].some((item) => item.mimeType !== folderMime)
      || !person.parents.includes(root.id) || !month.parents.includes(person.id) || !file.parents.includes(month.id)
      || month.name !== options.targetMonth.replace('-', '')) {
      throw new ReceiptReadError('SOURCE_MOVED_OR_POSTED', 'フォルダ構成または対象月が変わっています。再スキャンしてください');
    }
    const mime = z.enum(['application/pdf', 'image/jpeg', 'image/png']).safeParse(file.mimeType);
    if (!mime.success) throw new ReceiptReadError('UNSUPPORTED_FILE', 'PDF・JPEG・PNG以外は読み取りません');
    if (!file.capabilities?.canDownload) throw new ReceiptReadError('DOWNLOAD_NOT_ALLOWED', '原本ダウンロードの権限が確認できません');
    if (!file.size || !/^\d+$/.test(file.size) || Number(file.size) > MAX_RECEIPT_BYTES) {
      throw new ReceiptReadError('SIZE_LIMIT', '証憑サイズを確認できないか、10MiBを超えています');
    }
    const bytes = await get(file.id, true);
    const signatures: Record<ReceiptDocument['mimeType'], boolean> = {
      'application/pdf': bytes.subarray(0, 5).toString('ascii') === '%PDF-',
      'image/jpeg': bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
      'image/png': bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    };
    if (!bytes.length || !signatures[mime.data] || bytes.length !== Number(file.size)) {
      throw new ReceiptReadError('INVALID_FILE_BYTES', '証憑内容とファイル形式・サイズが一致しません');
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const hashes = [file.sha256Checksum, ...record.evidence.map((entry) => entry.sha256)].filter(Boolean);
    if (hashes.some((hash) => hash!.toLowerCase() !== sha256)) {
      throw new ReceiptReadError('SOURCE_CHANGED', '証憑内容がスキャン時点から変更されています。再スキャンしてください');
    }
    return { bytes, mimeType: mime.data, sha256 };
  };
}
