import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { reviewExpenseBatch } from './expense-intake.js';

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' }, rules: { type: 'string' }, output: { type: 'string' },
    },
    strict: true, allowPositionals: false,
  });
  if (!values.input || !values.rules) {
    throw new Error('使用方法: npm run accounting:review -- --input 証憑データ.json --rules ルール.json [--output レポート.json]');
  }
  const [input, rules] = await Promise.all([
    readFile(resolve(values.input), 'utf8'), readFile(resolve(values.rules), 'utf8'),
  ]);
  const report = reviewExpenseBatch(JSON.parse(input), JSON.parse(rules));
  const serialized = JSON.stringify(report, null, 2) + '\n';
  if (values.output) {
    const destination = resolve(values.output);
    await mkdir(dirname(destination), { recursive: true });
    // 同名レポートや入力ファイルの誤上書きを防ぐ。
    await writeFile(destination, serialized, { flag: 'wx', mode: 0o600 });
    console.log(`確認レポート: ${destination}`);
    console.log(`全${report.summary.total}件 / 候補${report.summary.candidates}件 / 要確認${report.summary.needsReview}件 / 入力不正${report.summary.invalid}件`);
  } else {
    process.stdout.write(serialized);
  }
}

main().catch((error: unknown) => {
  console.error(`取込中止: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
