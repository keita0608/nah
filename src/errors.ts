/**
 * エラーの要約とログ抑制。
 *
 * Stream SDK の onError には ws の ErrorEvent がそのまま渡ってくる。これを
 * `console.error(err)` すると WebSocket オブジェクト全体（内部バッファ、
 * ソケット、リスナ一覧…）が数十行ダンプされる。再接続が繰り返されると
 * ログファイルが際限なく肥大化するため、1 行に要約したうえで、
 * 同一エラーの連続出力を抑制する。
 */

/** 同一メッセージの再出力を抑える最小間隔（既定 60 秒）。 */
export const DEFAULT_THROTTLE_MS = 60_000;

/**
 * 未知のエラー値を 1 行の文字列に要約する純粋関数。
 * ws の ErrorEvent / CloseEvent / Error / 文字列 / その他を想定。
 */
export function summarizeError(err: unknown): string {
  if (err === null || err === undefined) return "(不明なエラー)";
  if (typeof err === "string") return err;

  const e = err as Record<string, any>;
  const parts: string[] = [];

  // ws の ErrorEvent は message を持つ。内部の error にも詳細が入る。
  const message =
    (typeof e.message === "string" && e.message) ||
    (typeof e.error?.message === "string" && e.error.message) ||
    (typeof e.reason === "string" && e.reason) ||
    "";
  if (message) parts.push(message);

  // fetch の失敗は message が "fetch failed" だけなので、cause に本当の原因が入る
  const causeMessage = e.cause?.message ?? e.cause?.code;
  if (typeof causeMessage === "string" && causeMessage && causeMessage !== message) {
    parts.push(`cause=${causeMessage}`);
  }

  // 接続系のエラーコード（ECONNREFUSED / ENOTFOUND など）
  const code = e.error?.code ?? e.code ?? e.cause?.code;
  if (code !== undefined && code !== null && typeof code !== "object") {
    parts.push(`code=${String(code)}`);
  }

  // WebSocket のクローズコード（1006 = 異常切断、1008 = ポリシー違反 など）
  const closeCode = e.target?._closeCode ?? e.wasClean;
  if (typeof closeCode === "number") parts.push(`closeCode=${closeCode}`);

  // HTTP ステータス（認証失敗の切り分けに重要: 401/403 = APIキー無効）
  const status = e.status ?? e.error?.status ?? e.target?._req?.res?.statusCode;
  if (typeof status === "number") parts.push(`status=${status}`);

  if (parts.length === 0) {
    const type = e.type ?? e.constructor?.name ?? typeof err;
    return `(詳細不明: ${String(type)})`;
  }
  return parts.join(" ");
}

/**
 * 401/403/1008 など「認証・認可の失敗」を示唆するかを判定する。
 * true ならスラッグや回線ではなく API キーが原因の可能性が高い。
 */
export function looksLikeAuthFailure(summary: string): boolean {
  return /status=(401|403)|closeCode=1008|unauthorized|forbidden|invalid.*(key|token)/i.test(
    summary,
  );
}

/**
 * 同一メッセージの連続出力を抑制するロガーを作る。
 * 抑制中に発生した件数は、次に出力するときにまとめて報告する。
 */
export function createThrottledLogger(
  throttleMs: number = DEFAULT_THROTTLE_MS,
  sink: (line: string) => void = (line) => console.error(line),
): (prefix: string, err: unknown) => void {
  let lastSummary = "";
  let lastLoggedAt = 0;
  let suppressed = 0;

  return (prefix: string, err: unknown): void => {
    const summary = summarizeError(err);
    const now = Date.now();

    if (summary === lastSummary && now - lastLoggedAt < throttleMs) {
      suppressed++;
      return;
    }

    const tail = suppressed > 0 ? `（同一エラーを${suppressed}件抑制）` : "";
    sink(`${prefix}: ${summary}${tail}`);

    if (looksLikeAuthFailure(summary)) {
      sink("   ⚠️ 認証エラーの可能性: OPENSEA_API_KEY が失効/無効かもしれません（npm run doctor で確認）");
    }

    lastSummary = summary;
    lastLoggedAt = now;
    suppressed = 0;
  };
}
