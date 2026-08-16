/**
 * 監視対象コレクション。
 *
 * { slug: 表示名 }。1 行追加すれば監視対象を増やせる。
 * 本体（index.ts）と診断（doctor.ts）が同じ定義を参照するよう、ここに切り出している。
 *
 * 注意: スラッグは OpenSea の URL 末尾（例: opensea.io/collection/【ここ】）と
 * 一致させること。Stream API は存在しないスラッグでもチャンネル参加が成功して
 * しまい、無反応の原因になっても気づけない。`npm run doctor` で実在確認できる。
 */
export const COLLECTIONS: Record<string, string> = {
  "the-key-nah": "THE KEY",
  "membership-s": "MEMBERSHIP S",
};
