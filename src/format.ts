/**
 * 整形ロジック（純粋関数）。
 *
 * ここで使う型は @opensea/stream-js の `ItemListedEventPayload` のうち、
 * 通知に必要なフィールドだけを抜き出したサブセット。SDK のペイロードは
 * 構造的にこれらの型へ代入可能なので、index.ts からは `event.payload` を
 * そのまま渡せる（キャスト不要）。
 *
 * フィールド名は OpenSea 公式の item_listed payload 仕様に厳密に一致させている。
 */

export interface ListingMetadata {
  name: string | null;
  image_url: string | null;
}

export interface ListingItem {
  nft_id: string;
  permalink: string;
  metadata: ListingMetadata;
}

export interface ListingPaymentToken {
  /** "ETH" / "WETH" など */
  symbol: string;
}

export interface ListingMaker {
  address: string;
}

export interface ListingPayload {
  /** wei 建ての出品価格（string） */
  base_price: string;
  payment_token: ListingPaymentToken;
  maker: ListingMaker;
  event_timestamp: string;
  listing_date: string;
  order_hash: string;
  item: ListingItem;
}

/** Slack Block Kit のブロック（最小型） */
export type SlackBlock = Record<string, unknown>;

export interface SlackMessage {
  /** 通知プレビュー / フォールバック用テキスト（必須） */
  text: string;
  blocks: SlackBlock[];
}

// ── 価格変換・フォーマット ──────────────────────────────────────────

/** wei (string) を ETH (number) に変換する。1e18 で割る。 */
export function weiToEth(wei: string): number {
  const n = Number(wei);
  return Number.isFinite(n) ? n / 1e18 : 0;
}

/** ETH を小数4桁の文字列に整形する（例: 0.15 → "0.1500"）。 */
export function formatEth(eth: number): string {
  return eth.toFixed(4);
}

/** 整数に3桁区切りカンマを入れる（ロケール非依存・決定的）。 */
function withThousands(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** ETH 額と為替レートから円換算文字列を作る（例: "約¥38,250"）。 */
export function formatJpy(eth: number, ethJpy: number): string {
  const yen = Math.round(eth * ethJpy);
  return `約¥${withThousands(yen)}`;
}

/**
 * 価格表示文字列を作る。
 * 例: "0.1500 ETH" / "0.1500 WETH" / "0.1500 ETH（約¥38,250）"
 * ethJpy が正の数のときだけ円換算を併記する。
 */
export function formatPrice(eth: number, symbol: string, ethJpy?: number): string {
  const base = `${formatEth(eth)} ${symbol}`;
  if (typeof ethJpy === "number" && Number.isFinite(ethJpy) && ethJpy > 0) {
    return `${base}（${formatJpy(eth, ethJpy)}）`;
  }
  return base;
}

// ── タイムスタンプ整形 ──────────────────────────────────────────────

/**
 * OpenSea のタイムスタンプ文字列を JST の "YYYY-MM-DD HH:mm JST" に整形する。
 * タイムゾーン指定が無い場合は UTC とみなす。パース不能ならそのまま返す。
 */
export function formatTimestamp(ts: string): string {
  if (!ts) return "(時刻不明)";
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(ts);
  const d = new Date(hasTz ? ts : `${ts}Z`);
  if (Number.isNaN(d.getTime())) return ts;
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000); // UTC+9
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())} ` +
    `${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())} JST`
  );
}

// ── アドレス短縮 ────────────────────────────────────────────────────

/** アドレス先頭10文字 + "…"（空なら "(unknown)"）。 */
export function shortAddress(address: string): string {
  if (!address) return "(unknown)";
  return `${address.slice(0, 10)}…`;
}

// ── 重複ガード用キー ────────────────────────────────────────────────

/**
 * 重複検知キー: `${item.nft_id}-${order_hash ?? event_timestamp}`
 * Stream API はベストエフォート配信（再送あり・順序前後あり）のため、
 * これをキーに直近分を記憶して二重通知を防ぐ。
 */
export function dedupeKey(payload: ListingPayload): string {
  const id = payload.item?.nft_id ?? "unknown";
  const suffix = payload.order_hash ?? payload.event_timestamp ?? "";
  return `${id}-${suffix}`;
}

// ── Slack メッセージ組み立て ────────────────────────────────────────

/**
 * item_listed payload から Slack（Block Kit）メッセージを組み立てる純粋関数。
 * 画像が無い / permalink が無いケースでも壊れない。
 */
export function buildSlackMessage(
  payload: ListingPayload,
  displayName: string,
  ethJpy?: number,
): SlackMessage {
  const eth = weiToEth(payload.base_price);
  const symbol = payload.payment_token?.symbol || "ETH";
  const priceText = formatPrice(eth, symbol, ethJpy);

  const name = payload.item?.metadata?.name || "（名称未取得）";
  const imageUrl = payload.item?.metadata?.image_url || null;
  const permalink = payload.item?.permalink || "";
  const makerAddress = payload.maker?.address || "";
  const listedAt = formatTimestamp(payload.listing_date || payload.event_timestamp);

  // 見出し: 🔑 新規出品 — {表示名}
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `🔑 新規出品 — ${displayName}`, emoji: true },
    },
  ];

  // *{item.metadata.name}*（画像があれば accessory にサムネ）
  const nameSection: SlackBlock = {
    type: "section",
    text: { type: "mrkdwn", text: `*${name}*` },
  };
  if (imageUrl) {
    nameSection.accessory = {
      type: "image",
      image_url: imageUrl,
      alt_text: name,
    };
  }
  blocks.push(nameSection);

  // フィールド: 価格 / 出品時刻
  blocks.push({
    type: "section",
    fields: [
      { type: "mrkdwn", text: `*価格*\n${priceText}` },
      { type: "mrkdwn", text: `*出品時刻*\n${listedAt}` },
    ],
  });

  // コンテキスト: 出品者アドレス先頭10文字
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `出品者: ${shortAddress(makerAddress)}` }],
  });

  // アクションボタン: OpenSeaで見る（permalink があるときだけ）
  if (permalink) {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "OpenSeaで見る", emoji: true },
          url: permalink,
          style: "primary",
        },
      ],
    });
  }

  // 通知プレビュー / フォールバック用テキスト
  const text = `🔑 新規出品 — ${displayName}｜${name}｜${priceText}`;

  return { text, blocks };
}
