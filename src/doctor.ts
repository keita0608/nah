/**
 * 診断スクリプト（doctor）。
 *
 * 「起動しているのに通知が来ない」ときの切り分け用。OpenSea の REST API を
 * 使って、以下を順に確認する:
 *
 *   1. 環境変数が読めているか
 *   2. API キーが有効か
 *   3. COLLECTIONS のスラッグが実在するか（← 無反応の最有力原因）
 *   4. そのコレクションに現在アクティブな出品があるか（＝出品自体が起きているか）
 *   5. ETH/JPY ライブレートが取れるか
 *
 * 実行例:
 *   npm run doctor
 *   （= node --env-file=.env --import tsx src/doctor.ts）
 *
 * Stream API はチャンネル参加時にスラッグの実在を検証しないため、
 * スラッグを間違えていても「参加成功」ログが出たまま無反応になる。
 * このスクリプトはそれを REST 側から検出する。
 */

import { COLLECTIONS } from "./collections.js";
import { weiToEth, formatEth } from "./format.js";
import { getEthJpy, refreshEthJpy } from "./rate.js";

const API_BASE = "https://api.opensea.io/api/v2";

const apiKey = process.env.OPENSEA_API_KEY;
if (!apiKey) {
  console.error("❌ OPENSEA_API_KEY が読めていません（.env を確認してください）");
  process.exit(1);
}

const headers = { accept: "application/json", "x-api-key": apiKey };

/** レスポンス本文を安全に読む（JSON でなければ生文字列の先頭を返す）。 */
async function readBody(res: Response): Promise<{ json?: any; text: string }> {
  const text = await res.text().catch(() => "");
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { text };
  }
}

/** コレクションが実在するか確認する。 */
async function checkCollection(slug: string, displayName: string): Promise<boolean> {
  const url = `${API_BASE}/collections/${slug}`;
  try {
    const res = await fetch(url, { headers });
    const { json, text } = await readBody(res);

    if (res.status === 200) {
      const name = json?.name ?? "(名称不明)";
      console.log(`   ✅ スラッグ実在: "${slug}" → OpenSea上の名称: ${name}`);
      return true;
    }
    if (res.status === 404) {
      console.log(`   ❌ スラッグが存在しません: "${slug}"`);
      console.log(`      → これが原因です。通知が永久に来ません。スラッグを修正してください。`);
      return false;
    }
    if (res.status === 401 || res.status === 403) {
      console.log(`   ❌ APIキーが拒否されました (HTTP ${res.status})`);
      console.log(`      → サーバ応答: ${text.slice(0, 200)}`);
      if (text.includes("expired")) {
        console.log(`      → 【確定】キーが失効しています。`);
      }
      console.log(`         opensea.io/settings/developer でキーを発行し直し、.env を更新してください。`);
      console.log(`         （ダッシュボードの EXPIRES 列で失効日を確認できます）`);
      return false;
    }
    console.log(`   ⚠️ 予期しない応答 (HTTP ${res.status}): ${text.slice(0, 200)}`);
    return false;
  } catch (err) {
    console.log(`   ❌ 通信エラー: ${String(err)}`);
    return false;
  }
}

/** 現在アクティブな出品を取得して、出品が起きているコレクションか確認する。 */
async function checkListings(slug: string): Promise<void> {
  const url = `${API_BASE}/listings/collection/${slug}/all?limit=20`;
  try {
    const res = await fetch(url, { headers });
    const { json, text } = await readBody(res);

    if (res.status !== 200) {
      console.log(`   ⚠️ 出品一覧の取得に失敗 (HTTP ${res.status}): ${text.slice(0, 200)}`);
      return;
    }

    const listings: unknown[] = Array.isArray(json?.listings) ? json.listings : [];
    if (listings.length === 0) {
      console.log(`   ℹ️ 現在アクティブな出品: 0 件`);
      console.log(`      → 監視は正常でも、出品が無ければ通知は来ません（異常ではありません）。`);
      return;
    }

    console.log(`   ✅ 現在アクティブな出品: ${listings.length} 件（取得上限20）`);
    for (const listing of listings.slice(0, 3)) {
      const current = (listing as any)?.price?.current;
      const value = current?.value;
      const currency = current?.currency ?? "ETH";
      const priceText =
        typeof value === "string" ? `${formatEth(weiToEth(value))} ${currency}` : "(価格形式不明)";
      console.log(`      - ${priceText}`);
    }
  } catch (err) {
    console.log(`   ⚠️ 出品一覧の通信エラー: ${String(err)}`);
  }
}

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════");
  console.log(" nah-watcher 診断");
  console.log("═══════════════════════════════════════════════\n");

  // 1. 環境変数
  console.log("【1】環境変数");
  console.log(`   OPENSEA_API_KEY   : ✅ 読み込み済み（先頭6文字: ${apiKey!.slice(0, 6)}…）`);
  console.log(
    `   SLACK_WEBHOOK_URL : ${process.env.SLACK_WEBHOOK_URL ? "✅ 読み込み済み" : "❌ 未設定"}`,
  );
  const ethJpyEnv = process.env.ETH_JPY?.trim();
  console.log(`   ETH_JPY(予備)     : ${ethJpyEnv ? `✅ ${ethJpyEnv}` : "－（未設定・任意）"}\n`);

  // 2 & 3. コレクションごとの確認
  console.log("【2】監視対象コレクション（スラッグ実在確認 & 出品状況）");
  let allValid = true;
  for (const [slug, displayName] of Object.entries(COLLECTIONS)) {
    console.log(`\n   ── ${displayName} (${slug}) ──`);
    const ok = await checkCollection(slug, displayName);
    if (!ok) {
      allValid = false;
      continue;
    }
    await checkListings(slug);
  }

  // 4. レート
  console.log("\n【3】ETH/JPY ライブレート");
  await refreshEthJpy();
  const rate = getEthJpy();
  console.log(
    rate
      ? `   ✅ 取得成功: 約¥${Math.round(rate).toLocaleString("en-US")} / ETH`
      : `   ⚠️ 取得できませんでした（.env の ETH_JPY があればそれを使います）`,
  );

  // 総合判定
  console.log("\n═══════════════════════════════════════════════");
  if (allValid) {
    console.log(" 判定: APIキー・スラッグとも正常です ✅");
    console.log(" 通知が来ない場合、単に『新規出品が発生していない』可能性が高いです。");
    console.log(" （Stream APIは「新規出品が起きた瞬間」だけ通知します。既存の出品は対象外）");
  } else {
    console.log(" 判定: 問題が見つかりました ❌ 上のログを確認してください。");
  }
  console.log("═══════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("診断中にエラー:", err);
  process.exit(1);
});
