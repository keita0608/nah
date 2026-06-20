import { OpenSeaStreamClient } from "@opensea/stream-js";
import { WebSocket } from "ws";
import { LocalStorage } from "node-localstorage";

import { buildSlackMessage, dedupeKey } from "./format.js";
import type { ListingPayload, SlackMessage } from "./format.js";

// ── 監視対象コレクション ────────────────────────────────────────────
// { slug: 表示名 }。1 行追加すれば監視対象を増やせる。
const COLLECTIONS: Record<string, string> = {
  "the-key-nah": "THE KEY",
  "membership-s": "MEMBERSHIP S",
};

// ── 環境変数の読み込み・検証 ────────────────────────────────────────

/** ETH_JPY（任意・数値）を解釈する。不正値は無視して undefined を返す。 */
function parseEthJpy(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(`⚠️ ETH_JPY が数値として不正なので無視します: "${raw}"`);
    return undefined;
  }
  return n;
}

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
    console.error("Slack通知でエラー:", err);
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

  const message = buildSlackMessage(payload, displayName, ETH_JPY);
  void postToSlack(message);
}

// ── プロセス全体のエラーハンドリング ────────────────────────────────
process.on("unhandledRejection", (reason) => {
  console.error("unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

// ── OpenSea Stream クライアント初期化（公式 Node.js 手順） ───────────
const client = new OpenSeaStreamClient({
  token: OPENSEA_API_KEY,
  connectOptions: {
    transport: WebSocket as any,
    sessionStorage: LocalStorage as any,
  },
  onError: (err) => console.error("Streamエラー:", err),
});

// ── 起動シーケンス ──────────────────────────────────────────────────
async function main(): Promise<void> {
  const names = Object.values(COLLECTIONS).join(" / ");

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
        console.error(`[${displayName}] ハンドラでエラー:`, err);
      }
    });
    console.log(`👀 購読開始: ${displayName} (${slug})`);
  }

  console.log(`✅ nah-watcher 稼働中。監視対象: ${names}`);
}

main().catch((err) => {
  console.error("起動シーケンスでエラー:", err);
  process.exit(1);
});
