/**
 * 向量比對。**純 JS 的暴力比對，沒有索引結構。**
 *
 * ## 為什麼沒有 ANN 索引
 *
 * ADR-0009：`sqlite-vec` 是原生模組，而這個工具的整個形狀
 * （零原生模組、一鍵啟動、`node:sqlite`）就是為了不裝那種東西。
 * 5 萬條 2560 維暴力比對量到 **69 ms**（2026-09-09）——
 * 而那個數字如果撐不住，ADR-0009 的「重新評估」觸發條件就成立了，
 * **那是一個決定，不是一個效能問題**。
 *
 * ## 為什麼是點積而不是餘弦
 *
 * 存進去的向量在寫入時就已經正規化成單位長度（`vector-repo`），
 * 所以餘弦相似度就是點積。**正規化放在寫入那一側**是因為它只做一次，
 * 而比對每次查詢都要跑 5 萬遍。
 *
 * 這件事有一個前提：**讀出來的東西真的是單位向量**。
 * 一個沒有正規化就寫進去的向量不會報錯，只會讓它的分數普遍偏高或偏低 ——
 * 所以 `normalized()` 是寫入路徑上的唯一入口，而不是一個「記得要呼叫」的步驟。
 */

/**
 * 單位化。**回一份新的**，不改原來那一份。
 *
 * 長度是 0 的時候回原樣（全零向量）——**不要除以 0 產生 NaN**：
 * 一個 NaN 的向量在排序時的行為取決於比較的順序，
 * 而那會讓同一份資料在不同查詢下出現在不同的位置。
 */
export function normalized(v: Float32Array): Float32Array {
  let sum = 0;
  for (let i = 0; i < v.length; i++) sum += (v[i] as number) * (v[i] as number);
  const len = Math.sqrt(sum);
  if (len === 0 || !Number.isFinite(len)) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / len;
  return out;
}

/** 兩個單位向量的相似度（＝餘弦）。**維度不同回 0**，不是丟例外。 */
export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number);
  return sum;
}
