# nah-watcher

**NOT A HOTEL 出品ウォッチャー** — OpenSea の Stream API（WebSocket）に常時接続し、
特定 NFT コレクションの **新規出品（`item_listed`）をリアルタイム検知して Slack に通知**する
Node / TypeScript 製の常駐サービスです。Railway での 24 時間常駐を想定しています。

## 監視対象

| slug           | 表示名         |
| -------------- | -------------- |
| `the-key-nah`  | THE KEY        |
| `membership-s` | MEMBERSHIP S   |

両コレクションの `item_listed` を **全件**（価格・属性フィルタなし）監視します。
監視対象は `src/index.ts` の `COLLECTIONS`（`{ slug: 表示名 }`）に 1 行追加するだけで増やせます。

```ts
const COLLECTIONS: Record<string, string> = {
  "the-key-nah": "THE KEY",
  "membership-s": "MEMBERSHIP S",
  // "another-slug": "別コレクション",   // ← 追加するだけ
};
```

## 仕組み

```
OpenSea Stream API (WebSocket)
        │  item_listed イベント
        ▼
  @opensea/stream-js  ──▶  重複ガード（直近2000件 Set）
        │                      │ 新規のみ
        ▼                      ▼
   src/format.ts ────────▶ Slack Incoming Webhook（Block Kit）
   （整形・純粋関数）
```

- 起動時にまず Slack へ「✅ 起動しました」を 1 回 POST して疎通確認してから購読を開始します。
- Stream API はベストエフォート配信（再送・順序前後あり）のため、
  `${item.nft_id}-${order_hash ?? event_timestamp}` をキーに直近 2000 件を記憶して二重通知を防ぎます。

## ファイル構成

```
.
├─ src/index.ts        本体（接続・購読・通知）
├─ src/format.ts       整形ロジック（純粋関数・テスト対象）
├─ src/format.test.ts  ユニットテスト
├─ package.json        scripts: build / start / dev / test
├─ tsconfig.json       ES2022 / ESM / strict / outDir dist
├─ railway.json        NIXPACKS・restartPolicy ALWAYS(最大10)
├─ .env.example        環境変数テンプレート
├─ .gitignore          node_modules / dist / .env / *.log
└─ README.md
```

## 環境変数

すべて `process.env` から読み込みます。**秘密情報はコード・git に一切含めません。**

| 変数                | 必須 | 説明                                                                 |
| ------------------- | :--: | -------------------------------------------------------------------- |
| `OPENSEA_API_KEY`   |  ✅  | OpenSea API キー                                                     |
| `SLACK_WEBHOOK_URL` |  ✅  | Slack Incoming Webhook URL                                           |
| `ETH_JPY`           |      | ETH→JPY レート（数値）。設定時のみ通知に「約¥◯◯」を併記、未設定なら省略 |

必須 2 つが無ければ起動時に明確なエラーを出して `process.exit(1)` します。

### OpenSea API キーの取得

```bash
curl -s -X POST https://api.opensea.io/api/v2/auth/keys | jq -r '.api_key'
```

出力された文字列を `OPENSEA_API_KEY` に設定します。
（参考: [OpenSea API docs](https://docs.opensea.io/reference/api-keys)）

### Slack Incoming Webhook の発行

1. <https://api.slack.com/apps> で **Create New App** →「From scratch」
2. アプリ名とワークスペースを選択して作成
3. 左メニュー **Incoming Webhooks** を開き、トグルを **On**
4. **Add New Webhook to Workspace** → 通知を送りたいチャンネルを選択して許可
5. 発行された `https://hooks.slack.com/services/T000/B000/xxxx` を `SLACK_WEBHOOK_URL` に設定

## ローカル実行

Node.js 20 以上が必要です。

```bash
# 1. 依存をインストール
npm install

# 2. 環境変数を用意（.env は .gitignore 済み）
cp .env.example .env
#   → .env を編集して OPENSEA_API_KEY / SLACK_WEBHOOK_URL を設定

# 3. 開発実行（tsx で直接起動）
npm run dev
```

その他のスクリプト:

```bash
npm test         # src/format.ts の純粋関数をユニットテスト
npm run build    # tsc で dist/ に出力
npm start        # node dist/index.js（ビルド済みを実行 = 本番相当）
```

> `npm run dev` / `npm start` は `.env` を自動読み込みしません。
> シェルで環境変数を export するか、Railway の Variables（後述）に登録してください。
> ローカルで `.env` を使いたい場合は `node --env-file=.env dist/index.js` のように起動できます。

## Railway デプロイ手順

WebSocket を張り続ける常駐プロセスなので、Railway のような
「プロセスを起動しっぱなしにできる」PaaS が適しています。

1. このリポジトリを GitHub に push する。
2. [Railway](https://railway.app/) で **New Project → Deploy from GitHub repo** を選び、
   このリポジトリを連携する。
3. **Variables** に環境変数を登録する（コードには絶対に書かない）:
   - `OPENSEA_API_KEY`
   - `SLACK_WEBHOOK_URL`
   - `ETH_JPY`（任意）
4. `railway.json` の設定で自動ビルド・起動される:
   - Builder: **NIXPACKS**
   - Build: `npm install && npm run build`
   - Start: `npm start`
   - Restart Policy: **ALWAYS**（最大 10 回まで自動再起動）
5. デプロイ後、起動通知「✅ 起動しました（THE KEY / MEMBERSHIP S を監視中）」が
   Slack に届けば疎通 OK。あとは新規出品があるたびに通知されます。

> このサービスはルートに `railway.json` を置いているため、Railway が自動で設定を検出します。

### Vercel / Cloudflare Workers は非推奨

本サービスは **WebSocket を常時張り続ける常駐プロセス**です。
Vercel（サーバーレス関数）や Cloudflare Workers（リクエスト駆動・短命）は
長時間の常駐接続に向かないため **非推奨**です。
Railway / Render / Fly.io / VPS など「プロセスを起動しっぱなしにできる」環境を使ってください。

## OpenSea Stream API の制約（重要）

- **ベータ版**の API です。仕様が変わる可能性があります。
- **ベストエフォート配信**: イベントの **再送はありません**。
- **順序は保証されません**（前後する可能性があります）。
- 切断中に発生したイベントは取りこぼします（再接続は SDK が自動で行います）。

これらの性質上、本サービスは「取りこぼしゼロ」を保証するものではなく、
リアルタイム通知のベストエフォートを提供します。重複については
`nft_id` + `order_hash` ベースの重複ガードで二重通知を防いでいます。

## 参考

- [OpenSea Stream API](https://docs.opensea.io/reference/stream-api-overview)
- [`@opensea/stream-js`](https://github.com/ProjectOpenSea/stream-js)
- [Slack Incoming Webhooks](https://api.slack.com/messaging/webhooks) / [Block Kit](https://api.slack.com/block-kit)
