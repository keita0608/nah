import { test } from "node:test";
import assert from "node:assert/strict";

import { parseEthJpyResponse, parseCoinbaseResponse } from "./rate.js";

test("parseEthJpyResponse (CoinGecko): 正常レスポンスからレートを取り出す", () => {
  assert.equal(parseEthJpyResponse({ ethereum: { jpy: 550000 } }), 550000);
});

test("parseEthJpyResponse (CoinGecko): 形式不正は undefined", () => {
  assert.equal(parseEthJpyResponse({}), undefined);
  assert.equal(parseEthJpyResponse({ ethereum: {} }), undefined);
  assert.equal(parseEthJpyResponse({ ethereum: { jpy: "550000" } }), undefined);
  assert.equal(parseEthJpyResponse({ ethereum: { jpy: 0 } }), undefined);
  assert.equal(parseEthJpyResponse(null), undefined);
  assert.equal(parseEthJpyResponse(undefined), undefined);
});

test("parseCoinbaseResponse: amount(文字列)を数値化して取り出す", () => {
  assert.equal(parseCoinbaseResponse({ data: { amount: "550000.50", currency: "JPY" } }), 550000.5);
});

test("parseCoinbaseResponse: 形式不正は undefined", () => {
  assert.equal(parseCoinbaseResponse({}), undefined);
  assert.equal(parseCoinbaseResponse({ data: {} }), undefined);
  assert.equal(parseCoinbaseResponse({ data: { amount: "abc" } }), undefined);
  assert.equal(parseCoinbaseResponse(null), undefined);
});
