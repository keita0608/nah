import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeError, looksLikeAuthFailure, createThrottledLogger } from "./errors.js";

// ── 要約 ────────────────────────────────────────────────────────────

test("summarizeError: Error は message を返す", () => {
  assert.equal(summarizeError(new Error("boom")), "boom");
});

test("summarizeError: 文字列はそのまま", () => {
  assert.equal(summarizeError("plain failure"), "plain failure");
});

test("summarizeError: null/undefined は既定文言", () => {
  assert.equal(summarizeError(null), "(不明なエラー)");
  assert.equal(summarizeError(undefined), "(不明なエラー)");
});

test("summarizeError: ws の ErrorEvent 風オブジェクトを1行に要約する", () => {
  // 巨大な target を持っていても、要約結果は短い1行であること
  const errorEvent = {
    type: "error",
    message: "connect ECONNREFUSED 1.2.3.4:443",
    error: { code: "ECONNREFUSED", message: "connect ECONNREFUSED 1.2.3.4:443" },
    target: { _closeCode: 1006, _receiver: {}, _sender: {}, _socket: null },
  };
  const summary = summarizeError(errorEvent);
  assert.ok(summary.includes("ECONNREFUSED"));
  assert.ok(summary.includes("closeCode=1006"));
  assert.ok(!summary.includes("_receiver"), "内部フィールドを含んではいけない");
  assert.ok(summary.length < 200, `要約が長すぎる: ${summary.length}`);
});

test("summarizeError: HTTPステータスを拾う（認証failureの切り分け用）", () => {
  const summary = summarizeError({ message: "Unexpected server response", status: 401 });
  assert.ok(summary.includes("status=401"));
});

// ── 認証failure判定 ─────────────────────────────────────────────────

test("looksLikeAuthFailure: 401/403/1008 を認証エラーとみなす", () => {
  assert.equal(looksLikeAuthFailure("Unexpected response status=401"), true);
  assert.equal(looksLikeAuthFailure("forbidden status=403"), true);
  assert.equal(looksLikeAuthFailure("closed closeCode=1008"), true);
  assert.equal(looksLikeAuthFailure("connect ECONNREFUSED closeCode=1006"), false);
});

// ── 抑制 ────────────────────────────────────────────────────────────

test("createThrottledLogger: 同一エラーの連続出力を抑制する", () => {
  const lines: string[] = [];
  const log = createThrottledLogger(60_000, (line) => lines.push(line));

  const err = new Error("同じエラー");
  for (let i = 0; i < 100; i++) log("Streamエラー", err);

  assert.equal(lines.length, 1, "100件発生しても出力は1行のみ");
  assert.equal(lines[0], "Streamエラー: 同じエラー");
});

test("createThrottledLogger: 抑制期間を過ぎたら件数付きで再出力する", () => {
  const lines: string[] = [];
  const log = createThrottledLogger(0, (line) => lines.push(line)); // 抑制なし設定

  log("Streamエラー", new Error("A"));
  log("Streamエラー", new Error("A"));

  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes("A"));
});

test("createThrottledLogger: 別のエラーは抑制せず出力する", () => {
  const lines: string[] = [];
  const log = createThrottledLogger(60_000, (line) => lines.push(line));

  log("Streamエラー", new Error("A"));
  log("Streamエラー", new Error("B"));

  assert.equal(lines.length, 2);
});

test("createThrottledLogger: 認証エラーには対処ヒントを添える", () => {
  const lines: string[] = [];
  const log = createThrottledLogger(60_000, (line) => lines.push(line));

  log("Streamエラー", { message: "unauthorized", status: 401 });

  assert.equal(lines.length, 2);
  assert.ok(lines[1].includes("OPENSEA_API_KEY"));
});
