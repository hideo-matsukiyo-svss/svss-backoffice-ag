export class ReceiptReadError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

/** Content-Lengthのないチャンク応答も上限を守る。エラー本文はログへ出さない。 */
export async function readLimitedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ReceiptReadError('HTTP_ERROR', `外部サービスの読取エラー（HTTP ${response.status}）`);
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new ReceiptReadError('SIZE_LIMIT', 'データのサイズ上限を超えています');
  }
  if (!response.body) throw new ReceiptReadError('EMPTY_BODY', 'データがありません');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        throw new ReceiptReadError('SIZE_LIMIT', 'データのサイズ上限を超えています');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks);
}
