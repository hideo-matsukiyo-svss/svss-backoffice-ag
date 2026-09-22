import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createDriveReader, scanDriveExpenses } from './drive-expenses.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { config: { type: 'string' }, output: { type: 'string' } },
    strict: true, allowPositionals: false,
  });
  if (!values.config || !values.output) {
    throw new Error('使用方法: npm run accounting:scan-drive -- --config .data/drive.json --output .data/scan.json');
  }
  const config: unknown = JSON.parse(await readFile(resolve(values.config), 'utf8'));
  const result = await scanDriveExpenses(createDriveReader(process.env.GOOGLE_DRIVE_ACCESS_TOKEN ?? ''), config);
  const destination = resolve(values.output);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify({ ...result.batch, scanNotices: result.notices }, null, 2) + '\n',
    { flag: 'wx', mode: 0o600 });
  console.log(`証憑一覧: ${destination} / ${result.batch.records.length}件 / 注意事項${result.notices.length}件`);
}

main().catch((error: unknown) => {
  console.error(`Drive取込中止: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
