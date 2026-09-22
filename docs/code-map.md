# 会計自動化のコード一覧

GitHubの **Code** タブでは、作業ブランチ `codex/accounting-automation-foundation` を選ぶと、
未マージのコードを含めて見られます。PRの **Files changed** は変更したファイルの一覧です。
`main` にはPRをマージするまで今回の機能は入りません。

| ファイル | 役割 |
| --- | --- |
| [drive-expenses.ts](../src/accounting/drive-expenses.ts) | 人別・月別フォルダから証憑一覧を取得 |
| [drive-receipt-download.ts](../src/accounting/drive-receipt-download.ts) | 原本の取得、階層・サイズ・SHA検証 |
| [openai-receipt-reader.ts](../src/accounting/openai-receipt-reader.ts) | PDF・画像をOpenAI APIで読み取る接続部分 |
| [receipt-extraction-schema.ts](../src/accounting/receipt-extraction-schema.ts) | 読取値・根拠文言のデータ形式 |
| [extract-expense-batch.ts](../src/accounting/extract-expense-batch.ts) | 読取件数制御、重複送信抑止、確認理由 |
| [expense-intake.ts](../src/accounting/expense-intake.ts) | 仕訳候補と要確認の振り分け |
| [input-validation.ts](../src/accounting/input-validation.ts) | 入力・ルールの検証 |
| [rules.ts](../src/accounting/rules.ts) | 勘定科目・部門・税区分の決定表 |
| [mf-cloud-invoice.ts](../src/accounting/mf-cloud-invoice.ts) | 売上の標準連携結果を検査 |
| [mf-journal-csv.ts](../src/accounting/mf-journal-csv.ts) | MF形式の仕訳CSV生成関数 |
| [test/](../test/) | 自動テスト |

操作手順: [一覧・仕訳候補](expense-intake.md) / [PDF・画像読取](receipt-extraction.md)
