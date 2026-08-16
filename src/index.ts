import { OpenSeaStreamClient, LogLevel } from "@opensea/stream-js";
import { WebSocket } from "ws";
import { LocalStorage } from "node-localstorage";

import { COLLECTIONS } from "./collections.js";
import { buildSlackMessage, dedupeKey } from "./format.js";
import type { ListingPayload, SlackMessage } from "./format.js";
import { createThrottledLogger, looksLikeAuthFailure, summarizeError } from "./errors.js";
import { getEthJpy, refreshEthJpy, startRatePolling } from "./rate.js";

// ── 環境変数の読み込み・検証 ────────────────────────────────────────

/**
 * ETH_JPY（任意・数値）を解釈する。不正値は無視して undefined を返す。
 * 通常はライブレート（CoinGecko）を使い、これはライブ取得に失敗したときの
 * フォールバックとして使われる。
 */
function parseEthJpy(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`⚠️ ETH_JPY が数値として不正なので無視します: "${raw}"`);
    return undefined;
  }
  return n;
}

/**
 * SDK のログ量。既定は WARN（再接続のたびに出る INFO ログでファイルが
 * 肥大化するため）。詳細が見たいときだけ LOG_LEVEL=info / debug を設定する。
 */
const SDK_LOG_LEVEL: LogLevel = ((): LogLevel => {
  switch ((process.env.LOG_LEVEL ?? "").trim().toLowerCase()) {
    case "debug":
      return LogLevel.DEBUG;
    case "info":
      return LogLevel.INFO;
    case "error":
      return LogLevel.ERROR;
    default:
      return LogLevel.WARN;
  }
})();

function readEnv(): { apiKey: string; webhookUrl: string; ethJpy?: number } {
  const apiKey = process.env.OPENSEA_API_KEY;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;

  const missing: string[] = [];
  if (!apiKey) missing.push("OPENSEA_API_KEY");
  if (!webhookUrl) missing.push("SLACK_WEBHOOK_URL");
  if (missing.length > 0) {
    console.error(`❌ 必須の環境変数が設定されていません: ${missing.join(", ")}`);
    console.error("   .env.example を参考に環境変数を設定してください。");
    process.exit(1);
  }

  return {
    apiKey: apiKey!,
    webhookUrl: webhookUrl!,
    ethJpy: parseEthJpy(process.env.ETH_JPY),
  };
}

const { apiKey: OPENSEA_API_KEY, webhookUrl: SLACK_WEBHOOK_URL, ethJpy: ETH_JPY } = readEnv();

// ── 重複ガード（直近 2000 件を記憶） ────────────────────────────────
const SEEN_LIMIT = 2000;
const seen = new Set<string>();

/** 未通知なら true（記録する）。既出なら false。2000 件超で古いものから間引く。 */
function markSeen(key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > SEEN_LIMIT) {
    // Set は挿入順を保持するので、最古の要素を 1 件削除する
    const oldest = seen.values().next().value;
    if (oldest !== undefined) seen.delete(oldest);
  }
  return true;
}

// ── Slack 通知 ──────────────────────────────────────────────────────

/** Slack Incoming Webhook へ POST する。失敗してもプロセスは落とさない。 */
async function postToSlack(message: SlackMessage): Promise<void> {
  try {
    const res = await fetch(SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`Slack通知失敗: HTTP ${res.status} ${res.statusText} ${body}`.trim());
    }
  } catch (err) {
    console.error(`Slack通知でエラー: ${summarizeError(err)}`);
  }
}

// ── item_listed ハンドラ ────────────────────────────────────────────

function handleListing(payload: ListingPayload, displayName: string): void {
  const key = dedupeKey(payload);
  if (!markSeen(key)) {
    console.log(`重複スキップ: ${key}`);
    return;
  }

  const name = payload.item?.metadata?.name ?? "(no name)";
  console.log(`🔑 新規出品検知: [${displayName}] ${name} (${key})`);

  // ライブレートを優先。未取得なら環境変数 ETH_JPY をフォールバックに使う。
  const rate = getEthJpy() ?? ETH_JPY;
  const message = buildSlackMessage(payload, displayName, rate);
  void postToSlack(message);
}

// ── プロセス全体のエラーハンドリング ────────────────────────────────
// オブジェクト全体をダンプするとログが肥大化するため、1 行に要約して出力する。
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", summarizeError(reason));
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", summarizeError(err));
});

// Stream のエラーは再接続のたびに連続発生しうるので、要約 + 抑制して出力する。
const logStreamError = createThrottledLogger();

// APIキー失効は「ログには出るが誰も気づかない」まま監視が止まる最悪のケースなので、
// 認証エラーを検知したら Slack にも警告する（連投を避けて 1 時間に 1 回まで）。
const AUTH_ALERT_INTERVAL_MS = 60 * 60 * 1000;
let lastAuthAlertAt = 0;

function handleStreamError(err: unknown): void {
  logStreamError("Streamエラー", err);

  const summary = summarizeError(err);
  if (!looksLikeAuthFailure(summary)) return;

  const now = Date.now();
  if (now - lastAuthAlertAt < AUTH_ALERT_INTERVAL_MS) return;
  lastAuthAlertAt = now;

  void postToSlack({
    text: "🚨 nah-watcher: OpenSea APIキーが無効/失効した可能性があります（監視が停止中）",
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text:
            "🚨 *nah-watcher: 監視が停止している可能性があります*\n" +
            "OpenSea Stream への接続が認証エラーで失敗しています。\n" +
            "APIキーの失効が最も多い原因です。",
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*エラー*\n\`${summary}\`` },
          { type: "mrkdwn", text: "*対処*\n`npm run doctor` で確認 → キーを再発行" },
        ],
      },
      {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: "キーの失効日は <https://opensea.io/settings/developer|OpenSea Developer 設定> の EXPIRES 列で確認できます",
          },
        ],
      },
    ],
  });
}

// ── OpenSea Stream クライアント初期化（公式 Node.js 手順） ───────────
const client = new OpenSeaStreamClient({
  token: OPENSEA_API_KEY,
  connectOptions: {
    transport: WebSocket as any,
    sessionStorage: LocalStorage as any,
  },
  // 既定は WARN。詳細を見たいときは LOG_LEVEL=info / debug を設定する。
  logLevel: SDK_LOG_LEVEL,
  onError: handleStreamError,
});

// ── 起動シーケンス ──────────────────────────────────────────────────
async function main(): Promise<void> {
  const names = Object.values(COLLECTIONS).join(" / ");

  // ETH→JPY のライブレートを初回取得し、以降は定期更新する。
  // 取得できなくてもフォールバック（環境変数 ETH_JPY）があれば動く。
  await refreshEthJpy();
  startRatePolling();
  if (getEthJpy() === undefined && ETH_JPY !== undefined) {
    console.log(`💱 ライブレート未取得のため、フォールバック ¥${ETH_JPY} を使用します`);
  }

  // まず Slack へ起動通知を 1 回 POST（疎通確認を兼ねる）
  await postToSlack({
    text: `✅ 起動しました（${names} を監視中）`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✅ *nah-watcher 起動しました*\n${names} の新規出品（item_listed）を監視中`,
        },
      },
    ],
  });

  // 各コレクションの item_listed を購読
  for (const [slug, displayName] of Object.entries(COLLECTIONS)) {
    client.onItemListed(slug, (event) => {
      try {
        handleListing(event.payload, displayName);
      } catch (err) {
        console.error(`[${displayName}] ハンドラでエラー: ${summarizeError(err)}`);
      }
    });
    console.log(`👀 購読開始: ${displayName} (${slug})`);
  }

  console.log(`✅ nah-watcher 稼働中。監視対象: ${names}`);
}

main().catch((err) => {
  console.error(`起動シーケンスでエラー: ${summarizeError(err)}`);
  process.exit(1);
});
