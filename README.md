# 督促AG（Mastra スターター）— SVSS 経理AG パイロット / P1

請求書の「督促」を自動で下書きするAIエージェントの、**動くたたき台**です。
Mastra（TypeScriptのエージェント基盤）で作ってあり、**ブラウザだけで継続的に開発**できます。
AIのAPIキーが無くても動きます。

## 会計自動化パイロット

MFクラウド請求書の売上は標準連携を使い、立替経費はGoogle Driveの「人別 → 月別」
証憑フォルダから取り込む方針です。経費申請の承認工程は追加しません。
読取専用の証憑一覧取得・仕訳候補・確認レポートを実装しました。OCRと本番登録は未実装です。

```bash
npm run accounting:demo  # 架空データで動作確認。認証不要、会計登録なし
```

実データの設定方法と制限は [立替経費の取込手順](docs/expense-intake.md)、
勘定科目などの設定は [会計ルール](docs/accounting-rules.md) を参照してください。
以下の督促AGとは独立したCLIです。

---

## 開発環境の全体像（どこで何が動く？）

```
  GitHub (コードの家)
     │  ← ここにコードを保存
     ▼
  GitHub Codespaces (開発する場所 = ブラウザ上のVS Code)
     │  ← ここで書く・動かす・試す。Macに何も入れなくてよい
     ▼
  Mastra Cloud (本番で動かす場所) ※あとで
```

**継続開発の本拠地は Codespaces**（GitHubが用意するクラウド開発環境）。Macに開発ツールを
入れる必要がなく、どのPCからでも同じ環境に入れます。

---

## はじめ方（Codespaces / 推奨）

1. このプロジェクト一式を、自分のGitHubリポジトリにアップロードする
   （新規リポジトリを作成 → ファイルをドラッグ&ドロップ。`node_modules`は入れない＝元々入っていません）
2. GitHubのリポジトリ画面で緑の **「Code」** ボタン → **「Codespaces」** タブ →
   **「Create codespace on main」**
3. 1〜2分待つと、ブラウザにVS Code＋ターミナルが開き、**部品の準備（npm install）が自動で終わっています**
4. ターミナルで動かす:

```bash
npm start      # 督促AGを1回実行（APIキー不要。下書きが出ます）
npm run dev     # Mastra Studio を起動（エージェント/ワークフローをUIで試せる）
```

5. 直したら保存する（＝継続開発の1サイクル）:

```bash
git add -A
git commit -m "督促ルールを調整"
git push
```

> `npm run dev` を実行すると **Mastra Studio**（http://localhost:4111）が自動でプレビュー表示されます。
> ここで `tokusaiWorkflow` を選び、入力に `{ "today": "2026-09-02" }` を渡すと、UI上で実行できます。

### AIでトーンも整えたい場合（任意）
`.env.example` を `.env` にコピーして `OPENAI_API_KEY` か `ANTHROPIC_API_KEY` を入れると、
テンプレ文面をAIが自然な敬語に整えます（`toneAgent`）。無ければテンプレのまま動きます。

---

## どこを触ればいい？（あなたの陣地）

**経理の勘が要る＝あなたが決める場所はここだけ**です👇

| ファイル | 何を決める |
|---|---|
| `src/logic/ladder.ts` | 督促の段階・日数・トーン・誰が承認するか（★一番大事） |
| `src/logic/segment.ts` | 「優良／通常／要注意」の線引き |
| `src/logic/template.ts` | 督促メールの文面テンプレ |
| `src/data/invoices.mock.ts` | 試すためのダミー請求データ（＝正解セットの置き場） |

ここの数字や文言を書き換えて `npm start` すれば、すぐ結果が変わります。
**プログラミングというより「ルールを書く」感覚**で触れます。

## いずれ本番化する場所（実装を深めるとき）

| ファイル | やること |
|---|---|
| `src/mastra/tools/mf-invoices.ts` | モックを **MFの実データ取得** に差し替え |
| `src/mastra/workflows/tokusai.workflow.ts` | ワークフロー本体。判断層記録・Slack通知のステップを追加 |
| `src/mastra/index.ts` | エージェント/ワークフローの登録（Studioに出る） |

---

## 仕組み（ざっくり）

```
MFから請求取得 → 期日超過を判定 → 顧客セグメント判定 → 段階に応じた下書き作成
   → （任意）AIでトーン調整 → 🟢自動 / 🔴要承認 に振り分けて出力
```

- **機械判定**（期日超過・段階・セグメント）は AI を使わない純ロジック。毎回同じ結果で安全。
- **AI**は「言い回しの調整」だけ。事実（金額・期日）は絶対に変えない設計。
- 送信そのものは**やらない**。人が承認してから送る（HITL）前提の「下書きAG」です。

## ファイル構成

```
.devcontainer/    ← Codespacesの環境設定（自動でNode22＋npm install）
src/
  logic/          ← ルール（あなたの陣地）
    ladder.ts         督促ラダー（段階・日数・トーン）★
    overdue.ts        期日超過の判定
    segment.ts        顧客セグメント
    template.ts       文面テンプレ
    types.ts          データの型
  data/
    invoices.mock.ts  ダミー請求データ
  mastra/           ← Mastra本体
    index.ts          Mastra登録
    agents/tone-agent.ts    トーン調整AI（任意）
    tools/mf-invoices.ts    MF取得（今はモック）
    workflows/tokusai.workflow.ts  ワークフロー
  run.ts            実行エントリ（npm start）
```

## 次の一歩（ロードマップ）

1. `invoices.mock.ts` を実データ形式にして、正解セットを20〜30件そろえる
2. `ladder.ts` の日数・トーンを実感に合わせて調整
3. `mf-invoices.ts` をMF実データにつなぐ
4. 🔴要承認をSlackに通知 → 代表がワンクリック承認する導線
5. 送信履歴を Notion（判断層）に冪等記録（二重督促防止）
