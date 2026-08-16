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
監視対象は `src/collections.ts` の `COLLECTIONS`（`{ slug: 表示名 }`）に 1 行追加するだけで増やせます。

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
- API キーの失効などで接続が認証エラーになった場合、**Slack に警告を送ります**
  （監視が無言で止まるのを防ぐため。連投を避けて 1 時間に 1 回まで）。

## ファイル構成

```
.
├─ src/index.ts         本体（接続・購読・通知）
├─ src/collections.ts   監視対象コレクション定義（1行追加で増やせる）
├─ src/format.ts        整形ロジック（純粋関数・テスト対象）
├─ src/rate.ts          ETH→JPY ライブレート取得
├─ src/errors.ts        エラー要約・ログ抑制（ログ肥大化対策）
├─ src/doctor.ts        診断スクリプト（npm run doctor）
├─ src/test-notify.ts   Slack通知の手動テスト（npm run test:notify）
├─ src/*.test.ts        ユニットテスト
├─ package.json         scripts: build / start / dev / test / doctor / test:notify
├─ tsconfig.json        ES2022 / ESM / strict / outDir dist
├─ railway.json         NIXPACKS・restartPolicy ALWAYS(最大10)
├─ .env.example         環境変数テンプレート
├─ .gitignore           node_modules / dist / .env / *.log
└─ README.md
```

## 環境変数

すべて `process.env` から読み込みます。**秘密情報はコード・git に一切含めません。**

| 変数                | 必須 | 説明                                                                 |
| ------------------- | :--: | -------------------------------------------------------------------- |
| `OPENSEA_API_KEY`   |  ✅  | OpenSea API キー                                                     |
| `SLACK_WEBHOOK_URL` |  ✅  | Slack Incoming Webhook URL                                           |
| `ETH_JPY`           |      | ETH→JPY レートの**フォールバック**値（数値）。通常はライブレートを自動取得（後述）。ライブ取得に失敗したときだけこの値を使う |
| `LOG_LEVEL`         |      | ログ量。既定 `warn`。詳細を見たいときのみ `info` / `debug`（常駐時は既定のままを推奨） |

必須 2 つが無ければ起動時に明確なエラーを出して `process.exit(1)` します。

### ETH→JPY のライブレート

円換算は **CoinGecko →（失敗時）Coinbase** の無料 API（いずれも API キー不要）から
ETH/JPY を自動取得して併記します。起動時に 1 回取得し、以降は 5 分ごとに更新します。

- どちらの API も使えないときは、フォールバックとして環境変数 `ETH_JPY` を使います。
- ライブ取得もフォールバックも無い場合のみ、通知から円換算を省略します（壊れません）。
- 固定レートで運用したい場合は `ETH_JPY` を設定しておけば、ライブが落ちても安定します。

### OpenSea API キーの取得

> ⚠️ **重要: OpenSea の API キーには有効期限があります。**
> 失効すると Stream に接続できず、**Slack 通知が止まったまま無反応**になります
> （REST では `{"errors":["API key has expired"]}` が返ります）。

**推奨: ダッシュボードで発行するキー（本番用）**

<https://opensea.io/settings/developer> にログインし、**Create key** でキーを発行します。
一覧に `CREATED` / `EXPIRES` が表示されるので、**失効日をここで確認できます**
（実測例: 2026-08-16 発行 → 2031-08-15 失効。約 5 年）。
レート上限も高く、後からローテートできるため常駐運用にはこちらを使ってください。

**お試し用: 自己発行キー（短期間で失効）**

```bash
curl -s -X POST https://api.opensea.io/api/v2/auth/keys | jq -r '.api_key'
```

サインアップ不要で即発行できますが、**短期間で失効します**
（レスポンスの `expires_at` に失効日時が入るので確認してください）。
動作確認には便利ですが、常駐運用には向きません。

出力された文字列を `OPENSEA_API_KEY` に設定します。
（参考: [OpenSea API docs](https://docs.opensea.io/reference/api-keys)）

キーが生きているかは、いつでも次で確認できます:

```bash
npm run doctor
```

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
npm test           # 純粋関数のユニットテスト
npm run build      # tsc で dist/ に出力
npm start          # node dist/index.js（ビルド済みを実行 = 本番相当）
npm run doctor     # 設定診断（APIキー・スラッグ・出品状況）
npm run test:notify # Slackにテスト通知を1通送る
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

## トラブルシューティング

### まず診断する

```bash
npm run doctor
```

APIキーの有効性・スラッグの実在・出品の有無・レート取得を一括で確認します。
「起動しているのに通知が来ない」ときは、まずこれを実行してください。

### 症状別の切り分け

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| ログに `Unexpected server response: 401` / `403` | **APIキーの失効**。最も多い | ダッシュボードでキーを発行し直す |
| ログに `❌ スラッグが存在しません` | コレクションのスラッグ違い | `src/collections.ts` を修正 |
| 起動通知は届くが出品通知が来ない | 単に新規出品が発生していない | `npm run doctor` で出品状況を確認 |
| Slack通知だけ来ない | Webhook URL 失効 | `npm run test:notify` で疎通確認 |

`Successfully joined channel` は**スラッグが正しい証明にはなりません**。
Stream API は存在しないスラッグでも参加を受け付けるため、
スラッグの検証は必ず `npm run doctor`（REST API 経由）で行ってください。

### ログの確認

Windows でログを検索する例:

```bat
findstr /C:"Unexpected server response" watcher.log
findstr /C:"新規出品検知" watcher.log
```

### ログが肥大化する場合

本サービスはエラーを 1 行に要約し、同一エラーの連続出力を 60 秒間抑制します
（再接続が続いても肥大化しません）。それでも長期運用でログを抑えたい場合は、
NSSM 側のローテーションを有効にしてください:

> ⚠️ `nssm` は PATH に入っていないことが多いので、**フルパスで実行**してください
> （例: `C:\nssm\win64\nssm.exe`）。また `stop` / `start` / `set` は**管理者権限**が必要です。
> 毎回打つのが面倒なら `nssm.exe` を `C:\Windows\` にコピーすると `nssm ...` だけで実行できます。

```bat
C:\nssm\win64\nssm.exe set nah-watcher AppRotateFiles 1
C:\nssm\win64\nssm.exe set nah-watcher AppRotateOnline 1
C:\nssm\win64\nssm.exe set nah-watcher AppRotateBytes 10485760
C:\nssm\win64\nssm.exe restart nah-watcher
```

（10MB を超えたらローテーション。`AppRotateSeconds 86400` で日次ローテも可能）

すでに巨大なログができてしまっている場合は、サービスを止めてから削除します:

```bat
C:\nssm\win64\nssm.exe stop nah-watcher
del watcher.log
C:\nssm\win64\nssm.exe start nah-watcher
```

> `del` で「別のプロセスが使用中です」と出る場合は、`stop` が効いていません
> （管理者権限か、nssm のパスを確認してください）。サービスが停止していれば削除できます。

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
