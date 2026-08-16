/**
 * ETH→JPY のリアルタイムレート取得。
 *
 * 無料・APIキー不要のエンドポイント（CoinGecko → Coinbase の順に試行）から
 * ETH の円建て価格を定期取得してキャッシュする。1 つが落ちても次のソースに
 * フォールバックする。すべて失敗しても直近の値を保持し続け、ライブ値が
 * 一度も取れていない場合は呼び出し側のフォールバック（環境変数 ETH_JPY）を使う。
 */

import { summarizeError } from "./errors.js";

/** 既定のポーリング間隔（5 分）。各 API の無料枠レート制限に配慮。 */
export const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

const REQUEST_HEADERS = {
  accept: "application/json",
  "user-agent": "nah-watcher/1.0 (+https://github.com/keita0608/nah)",
};

interface RateSource {
  name: string;
  url: string;
  parse: (data: unknown) => number | undefined;
}

/**
 * CoinGecko のレスポンス（`{ "ethereum": { "jpy": 550000 } }`）から
 * 正の数値レートを取り出す純粋関数。形式不正なら undefined。
 */
export function parseEthJpyResponse(data: unknown): number | undefined {
  const rate = (data as { ethereum?: { jpy?: unknown } } | null)?.ethereum?.jpy;
  return toPositiveNumber(rate);
}

/**
 * Coinbase のレスポンス（`{ "data": { "amount": "550000.00", ... } }`）から
 * 正の数値レートを取り出す純粋関数。amount は文字列なので数値化する。
 */
export function parseCoinbaseResponse(data: unknown): number | undefined {
  const amount = (data as { data?: { amount?: unknown } } | null)?.data?.amount;
  if (typeof amount === "string") return toPositiveNumber(Number(amount));
  return toPositiveNumber(amount);
}

function toPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

const SOURCES: RateSource[] = [
  {
    name: "CoinGecko",
    url: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=jpy",
    parse: parseEthJpyResponse,
  },
  {
    name: "Coinbase",
    url: "https://api.coinbase.com/v2/prices/ETH-JPY/spot",
    parse: parseCoinbaseResponse,
  },
];

let cachedRate: number | undefined;

/** 直近に取得できたライブレート（未取得なら undefined）。 */
export function getEthJpy(): number | undefined {
  return cachedRate;
}

/**
 * ライブレートを 1 回取得してキャッシュを更新する。
 * ソースを順に試し、最初に成功した値を採用する。失敗してもプロセスは落とさない。
 */
export async function refreshEthJpy(): Promise<void> {
  for (const source of SOURCES) {
    try {
      const res = await fetch(source.url, { headers: REQUEST_HEADERS });
      if (!res.ok) {
        console.error(`ETH価格取得失敗 (${source.name}): HTTP ${res.status} ${res.statusText}`.trim());
        continue;
      }
      const rate = source.parse(await res.json());
      if (rate === undefined) {
        console.error(`ETH価格取得 (${source.name}): レスポンス形式が想定外でした`);
        continue;
      }
      // ログ肥大化を避けるため、初回と「1%以上変動したとき」だけ出力する。
      const changedEnough =
        cachedRate === undefined || Math.abs(rate - cachedRate) / cachedRate >= 0.01;
      cachedRate = rate;
      if (changedEnough) {
        console.log(
          `💱 ETH/JPY 更新: 約¥${Math.round(rate).toLocaleString("en-US")} (${source.name})`,
        );
      }
      return;
    } catch (err) {
      console.error(`ETH価格取得でエラー (${source.name}): ${summarizeError(err)}`);
    }
  }
  console.error("ETH価格: すべてのソースで取得に失敗しました（直近値 / フォールバックを使用）");
}

/** 一定間隔でライブレートを更新し続ける。タイマーは unref してプロセス終了を妨げない。 */
export function startRatePolling(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): NodeJS.Timeout {
  const timer = setInterval(() => void refreshEthJpy(), intervalMs);
  timer.unref();
  return timer;
}
