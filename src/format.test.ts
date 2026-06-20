import { test } from "node:test";
import assert from "node:assert/strict";

import {
  weiToEth,
  formatEth,
  formatJpy,
  formatPrice,
  formatTimestamp,
  shortAddress,
  dedupeKey,
  buildSlackMessage,
} from "./format.js";
import type { ListingPayload, SlackBlock } from "./format.js";

// 実データを模した item_listed payload。
// base_price "150000000000000000" = 0.15 ETH / name "SURF AOSHIMA - FEB.15, 2025"
function makePayload(): ListingPayload {
  return {
    base_price: "150000000000000000",
    payment_token: { symbol: "ETH" },
    maker: { address: "0x1234567890abcdef1234567890abcdef12345678" },
    event_timestamp: "2025-02-15T03:00:00.000000",
    listing_date: "2025-02-15T03:00:00.000000",
    order_hash: "0xdeadbeef",
    item: {
      nft_id: "ethereum/0xabc/42",
      permalink: "https://opensea.io/assets/ethereum/0xabc/42",
      metadata: {
        name: "SURF AOSHIMA - FEB.15, 2025",
        image_url: "https://example.com/surf.png",
      },
    },
  };
}

/** ブロック配列から指定 type の最初のブロックを取り出す（テスト用ヘルパ）。 */
function findBlock(blocks: SlackBlock[], type: string): any {
  return blocks.find((b) => (b as any).type === type);
}

// ── ETH 変換 ────────────────────────────────────────────────────────

test("weiToEth: 150000000000000000 wei = 0.15 ETH", () => {
  assert.equal(formatEth(weiToEth("150000000000000000")), "0.1500");
  assert.ok(Math.abs(weiToEth("1000000000000000000") - 1) < 1e-12);
});

test("weiToEth: 不正値は 0", () => {
  assert.equal(weiToEth("not-a-number"), 0);
  assert.equal(weiToEth(""), 0);
});

// ── 円換算 ──────────────────────────────────────────────────────────

test("formatJpy: 0.15 ETH @ 255000 = 約¥38,250", () => {
  assert.equal(formatJpy(0.15, 255000), "約¥38,250");
});

test("formatPrice: ETH のみ（ETH_JPY 未設定）", () => {
  assert.equal(formatPrice(0.15, "ETH"), "0.1500 ETH");
});

test("formatPrice: ETH + 円換算併記", () => {
  assert.equal(formatPrice(0.15, "ETH", 255000), "0.1500 ETH（約¥38,250）");
});

// ── タイムスタンプ ──────────────────────────────────────────────────

test("formatTimestamp: UTC → JST (+9h)", () => {
  // 03:00 UTC は 12:00 JST
  assert.equal(formatTimestamp("2025-02-15T03:00:00.000000"), "2025-02-15 12:00 JST");
});

// ── アドレス短縮 ────────────────────────────────────────────────────

test("shortAddress: 先頭10文字 + …", () => {
  assert.equal(shortAddress("0x1234567890abcdef1234567890abcdef12345678"), "0x12345678…");
  assert.equal(shortAddress(""), "(unknown)");
});

// ── 重複キー ────────────────────────────────────────────────────────

test("dedupeKey: nft_id-order_hash", () => {
  assert.equal(dedupeKey(makePayload()), "ethereum/0xabc/42-0xdeadbeef");
});

test("dedupeKey: order_hash が無ければ event_timestamp にフォールバック", () => {
  const payload = makePayload();
  (payload as any).order_hash = undefined;
  assert.equal(dedupeKey(payload), "ethereum/0xabc/42-2025-02-15T03:00:00.000000");
});

// ── メッセージ JSON（基本ケース） ───────────────────────────────────

test("buildSlackMessage: 構造・フィールド・画像・ボタン", () => {
  const msg = buildSlackMessage(makePayload(), "THE KEY", 255000);

  // フォールバック text（通知プレビュー）
  assert.ok(msg.text.includes("THE KEY"));
  assert.ok(msg.text.includes("SURF AOSHIMA - FEB.15, 2025"));
  assert.ok(msg.text.includes("0.1500 ETH（約¥38,250）"));

  // 見出し
  const header = findBlock(msg.blocks, "header");
  assert.equal(header.text.text, "🔑 新規出品 — THE KEY");

  // 名前セクション + サムネ画像 accessory
  const nameSection = msg.blocks[1] as any;
  assert.equal(nameSection.text.text, "*SURF AOSHIMA - FEB.15, 2025*");
  assert.equal(nameSection.accessory.type, "image");
  assert.equal(nameSection.accessory.image_url, "https://example.com/surf.png");

  // 価格 / 出品時刻フィールド
  const fields = (msg.blocks[2] as any).fields;
  assert.equal(fields[0].text, "*価格*\n0.1500 ETH（約¥38,250）");
  assert.ok(fields[1].text.startsWith("*出品時刻*"));

  // 出品者コンテキスト
  const context = findBlock(msg.blocks, "context");
  assert.equal(context.elements[0].text, "出品者: 0x12345678…");

  // OpenSea ボタン
  const actions = findBlock(msg.blocks, "actions");
  assert.equal(actions.elements[0].url, "https://opensea.io/assets/ethereum/0xabc/42");
  assert.equal(actions.elements[0].text.text, "OpenSeaで見る");

  // JSON シリアライズできる（Slack へ送れる形）
  assert.doesNotThrow(() => JSON.stringify(msg));
});

// ── WETH ケース（円換算なし） ───────────────────────────────────────

test("buildSlackMessage: WETH + ETH_JPY なし", () => {
  const payload = makePayload();
  payload.payment_token = { symbol: "WETH" };

  const msg = buildSlackMessage(payload, "MEMBERSHIP S");
  const fields = (msg.blocks[2] as any).fields;
  assert.equal(fields[0].text, "*価格*\n0.1500 WETH");
  assert.ok(!msg.text.includes("¥"));
});

// ── 画像なしケース ──────────────────────────────────────────────────

test("buildSlackMessage: image_url=null でも accessory を付けず壊れない", () => {
  const payload = makePayload();
  payload.item = {
    ...payload.item,
    metadata: { name: "No Image Item", image_url: null },
  };

  const msg = buildSlackMessage(payload, "THE KEY");
  const nameSection = msg.blocks[1] as any;
  assert.equal(nameSection.accessory, undefined);
  assert.doesNotThrow(() => JSON.stringify(msg));
});

// ── permalink なしケース ────────────────────────────────────────────

test("buildSlackMessage: permalink が空ならボタンを出さない", () => {
  const payload = makePayload();
  payload.item = { ...payload.item, permalink: "" };

  const msg = buildSlackMessage(payload, "THE KEY");
  assert.equal(findBlock(msg.blocks, "actions"), undefined);
});

// ── name=null ケース ────────────────────────────────────────────────

test("buildSlackMessage: name=null でもフォールバック名で壊れない", () => {
  const payload = makePayload();
  payload.item = {
    ...payload.item,
    metadata: { name: null, image_url: null },
  };

  const msg = buildSlackMessage(payload, "THE KEY");
  const nameSection = msg.blocks[1] as any;
  assert.equal(nameSection.text.text, "*（名称未取得）*");
});
