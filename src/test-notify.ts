/**
 * 手動テスト用スクリプト。
 *
 * ダミーの 4.5 ETH 出品を、本番と同じ整形ロジック（buildSlackMessage）＋
 * ライブレートで組み立てて Slack に 1 通だけ送る。Slack の見た目・円換算の
 * 確認用。実行例:
 *
 *   node --env-file=.env --import tsx src/test-notify.ts
 *   （ビルド後なら: node --env-file=.env dist/test-notify.js）
 */

import { buildSlackMessage } from "./format.js";
import type { ListingPayload, SlackMessage } from "./format.js";
import { getEthJpy, refreshEthJpy } from "./rate.js";

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
if (!SLACK_WEBHOOK_URL) {
  console.error("❌ SLACK_WEBHOOK_URL が未設定です。 .env を確認してください。");
  process.exit(1);
}

/** .env の ETH_JPY をフォールバックとして読む（不正値は無視）。 */
function readEthJpyFallback(): number | undefined {
  const raw = process.env.ETH_JPY;
  if (!raw || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ── ダミーの 4.5 ETH 出品（中身は適当） ──────────────────────────────
const now = new Date().toISOString();
const fakePayload: ListingPayload = {
  base_price: "4500000000000000000", // 4.5 ETH（wei）
  payment_token: { symbol: "ETH" },
  maker: { address: "0xTEST00000000000000000000000000000000TEST" },
  event_timestamp: now,
  listing_date: now,
  order_hash: `test-${Date.now()}`,
  item: {
    nft_id: "ethereum/0xtest/4500",
    permalink: "https://opensea.io/collection/the-key-nah",
    metadata: {
      name: "【テスト】SURF AOSHIMA - TEST LISTING",
      image_url: "https://placehold.co/600x400.png?text=NAH+TEST",
    },
  },
};

async function main(): Promise<void> {
  // ライブレートを取得（本番と同じ経路）。取れなければ .env の ETH_JPY を使う。
  await refreshEthJpy();
  const rate = getEthJpy() ?? readEthJpyFallback();
  console.log(
    `使用レート: ${rate ? `約¥${Math.round(rate).toLocaleString("en-US")}/ETH` : "(なし → 円換算は省略)"}`,
  );

  const message: SlackMessage = buildSlackMessage(fakePayload, "THE KEY（テスト）", rate);
  console.log("プレビュー:", message.text);

  const res = await fetch(SLACK_WEBHOOK_URL!, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(message),
  });

  if (res.ok) {
    console.log("✅ テスト通知を送信しました。Slack を確認してください。");
  } else {
    const body = await res.text().catch(() => "");
    console.error(`❌ 送信失敗: HTTP ${res.status} ${res.statusText} ${body}`.trim());
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("テスト通知でエラー:", err);
  process.exit(1);
});
