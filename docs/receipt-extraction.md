# PDF・画像からの読取候補

Google Driveのスキャン結果に対して原本を読み、日付・税込合計・通貨・販売元を
OpenAI Responses APIで抽出する接続部分です。PDF、JPEG、PNGを対象とします。
単独CLIであり、会計登録、CSV出力、Drive変更、メール送信は行いません。

経費申請の承認フローは追加しません。初期パイロットの読取結果はすべて未確定として扱い、
原本との照合・精度検証を経てから本番の自動計上条件を決めます。

## 実行前に必要なもの

- 内容の外部送信先をOpenAI APIとすることについて、社内で確認済みであること。
- `.env` の `GOOGLE_DRIVE_ACCESS_TOKEN`: 対象Driveのファイル内容を読める権限。
  一覧取得だけに使う `drive.metadata.readonly` では原本を取得できません。
  実際の対象に限定したアクセス権を持つ認証主体で、必要な読取スコープを設定します。
  読取専用の例は `drive.readonly` ですが、スコープ自体は広いので付与前に確認してください。
- `.env` の `OPENAI_API_KEY` と `OPENAI_RECEIPT_MODEL`。
  モデルはPDF・画像入力、Responses API、Structured Outputsに対応する利用可能なモデルを指定します。
  価格や利用権限を勝手に決めないため、モデルの既定値はありません。
- CodexのDrive接続・ChatGPTへのログインとは別の、アプリ実行用の認証です。
  キーやトークンを会話・GitHubに貼らないでください。

## 実行

最初は最新スキャンの少数（例: 1件）で確認します。送信許可フラグがない場合はAPIへ送信しません。

```bash
npm run accounting:scan-drive -- --config .data/drive.json --output .data/scan-new.json
npm run accounting:extract -- --input .data/scan-new.json --output .data/extracted-1.json --allow-external-processing --max-documents 1
npm run accounting:review -- --input .data/extracted-1.json --rules .data/rules.json --output .data/review-1.json
```

`--max-documents` は1〜20（既定5）。取得に失敗したものも件数枠を消費します。
同一バッチの同一ファイルや同一内容の再送信は抑止します。これは課金額の保証ではありません。
出力先を先に排他的に確保し、既存ファイルがあれば有料APIを呼ぶ前に中止します。
異常終了時に空の出力ファイルが残ることがあります。次回は別名を指定してください。
出力は0600で作り、標準出力にはパスと件数のみ表示します。

件数上限で未送信の行は `EXTRACTION_LIMIT` となります。次の実行で前回出力を入力にすると、
その行から続きを処理できます。成功・通信失敗・取得失敗の行は自動再送しません。
失敗を再試行する場合は原因を解決し、元のスキャンから対象行だけを選んだ別入力を作ってください。
再送時は料金が発生する場合があります。バッチを跨ぐ課金重複の永続台帳はありません。

## 結果の見方

各行の `extraction` に、使用モデル・プロンプト版・原本SHA-256・読取候補・確認理由を残します。
取得前に失敗した場合はSHAや読取候補がないことがあります。

| 項目 | 意味 |
| --- | --- |
| `observation.transactionDate` | 実際の取引日候補。発行日・支払期限・アップロード日で代用しない |
| `observation.amount` | 単一取引の税込合計候補。小計・税額・預かり金・お釣りを使わない |
| `observation.currency` | 通貨。日本円と確認できなければ未確定、為替換算はしない |
| `observation.merchant` | 発行元・販売元。宛名や社員名とは区別する |
| `quote` / `page` | 候補ごとの根拠文言とページ。AIが提示したもので、正しさの保証ではない |
| `documentType` / `paymentStatus` | 領収書・請求書等の種別と支払済み表示。立替者本人の支払いを証明するものではない |
| `issues` / `warnings` | 不足、根拠なし、複数証憑、対象月外、円未確認、通信失敗など |

元の `amount`・`transactionDate`・`merchant`・社員・部門・会計ルールは上書きしません。
明瞭に読み取れない値は `null` にするよう指示し、推測を依頼しません。
日付・整数円等の形式検証も行いますが、モデルが誤読する可能性は残ります。
`extraction` のある行は `accounting:review` でも仕訳候補に進めません。
確認済み値を計上用入力に反映する操作・画面と、その監査履歴は次の実装対象です。

## 原本・通信の安全策

- 取得先はGoogle Drive APIに固定し、証憑内や入力の任意URLを辿りません。
- 取得時にルート→人→月→ファイルの親子関係、対象月名、削除状態を再確認します。
  月名が `YYYYMM_計上済` に変わっていたら取得を止めます。
- ダウンロード可否、1件10MiBの上限、MIMEと先頭シグネチャ、実サイズ、SHAを照合します。
  メタデータと取得の間に変わった内容、スキャン時ハッシュと異なる原本はAIへ送りません。
- HTTPリダイレクトを追跡せず、タイムアウトとレスポンスサイズ上限を設けます。
  ファイルの完全な構造解析・マルウェア検査・PDFページ数の事前制限は未実装です。
- APIは1文書ずつ呼びます。証憑は指示ではなくデータとして扱い、ツール利用を有効にしません。
  文書内に悪意のある指示がある場合も含め、結果を会計へ直接登録しません。
- 根拠データ以外の社員マスタ、フォルダ名、フォルダIDをOpenAI APIのプロンプトへ追加しません。
  ただし、原本に記載されている情報は原本とともに送信されます。
- 原本をディスク保存せずメモリ上で扱います。OpenAIのFiles APIにはアップロードせず、
  Responses APIのインライン入力を使い `store: false` を指定します。
  **これはゼロ保持の保証ではありません。** 不正利用監視等の保持条件はAPI契約・設定に依存します。

取得時点と後日の原本が同じである保証、スキャン後に追加された別の同名/計上済フォルダの再検出、
処理済み台帳との照合はまだありません。最新のスキャンを使い、計上前に原本を再確認してください。

## 検証範囲

```bash
npm run typecheck
npm test
```

API通信を模擬し、PDF/画像の送信形式、拒否・未完了・不正出力、外部送信許可、
原本差し替え、上書き防止、同一バッチの再送防止を検証します。
テストには合成バイト列を使い、実際の証憑や実APIへはアクセスしません。
**実PDF・画像のOCR精度と、実環境での接続は未検証です。**
本番利用前に、送信許可・実行環境の認証を用意し、少数の証憑を人の正解値と照合してください。

## 公式仕様

- [OpenAI ファイル入力](https://developers.openai.com/api/docs/guides/file-inputs)
- [画像入力](https://developers.openai.com/api/docs/guides/images-vision)
- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI APIのデータ保持](https://developers.openai.com/api/docs/guides/your-data)
- [Driveのファイル取得](https://developers.google.com/workspace/drive/api/guides/manage-downloads)
- [Driveの認証スコープ](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)
