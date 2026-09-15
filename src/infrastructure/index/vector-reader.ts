/**
 * 語意檢索那一路的候選。**逐批讀、逐批比，不把 5 萬條一次拉進記憶體。**
 *
 * 5 萬條 2560 維 ＝ **500 MB**。一次 `SELECT *` 出來的話，
 * 一次搜尋的記憶體尖峰會超過整個工具其餘部分的總和 ——
 * 而這是一個要能在消費級機器上跑的東西。
 *
 * 所以：`listVectors` 一次 `SCAN_BATCH` 條，而累積的只有「每份文件最像的那一段」，
 * **記憶體用量與資料量無關**。代價是比對時間仍然是線性的，
 * 而那正是 v0.12.0 要量的那一條（5 萬筆 < 500 ms）。
 *
 * ## 一份文件有好幾段，而回給上層的是文件
 *
 * 段落級的向量意思是同一份文件會出現好幾次。上層要的是「哪幾份文件」，
 * 所以這裡**取每份文件最像的那一段**（max，不是平均）。
 *
 * 用平均會讓長文件吃虧：一份文件只有第 3 段講到你問的事，
 * 其餘 5 段都不相關 —— 平均之後它輸給一份通篇泛泛而談的短文件。
 * **而使用者要的就是第 3 段。**
 */
import type { DatabaseSync } from 'node:sqlite';

import { dot } from '../../domain/search/similarity.js';
import { listVectors } from '../db/repositories/vector-repo.js';
import type { IndexCandidate } from './reader.js';

/** 一次從資料庫讀幾條向量。**2000 × 2560 × 4 byte ＝ 20 MB 的尖峰。** */
export const SCAN_BATCH = 2000;

export interface SemanticHit extends IndexCandidate {
  /** 命中的是第幾段。**畫面要標位置，而位置由這個序號重算得到。** */
  readonly ord: number;
}

/** `<itemId>#<ord>` → 兩半。**沒有 `#` 的當成第 0 段**（舊資料或別種擁有者）。 */
export function splitVectorId(id: string): { readonly ownerId: string; readonly ord: number } {
  const at = id.lastIndexOf('#');
  if (at < 0) return { ownerId: id, ord: 0 };
  const ord = Number(id.slice(at + 1));
  return { ownerId: id.slice(0, at), ord: Number.isFinite(ord) ? ord : 0 };
}

/**
 * 跟這個查詢向量最像的幾份資料。
 *
 * **`score` 是餘弦**（向量都是單位長度，所以點積就是它）。
 * 上層不會直接拿它排序 —— 它進 `interleave` 之後只剩名次，
 * 理由寫在那一支：**餘弦跟 bigram 次數之間沒有換算率。**
 */
export function semanticCandidates(
  db: DatabaseSync,
  query: Float32Array,
  input: { readonly model: string; readonly limit: number },
): readonly SemanticHit[] {
  const dim = query.length;
  if (dim === 0) return [];

  // **每份文件只留最像的那一段**，理由見檔頭。
  const best = new Map<string, { score: number; ord: number }>();
  let after = '';
  for (;;) {
    const batch = listVectors(db, { model: input.model, dim, limit: SCAN_BATCH, after });
    if (batch.length === 0) break;
    for (const row of batch) {
      const score = dot(query, row.embedding);
      const { ord } = splitVectorId(row.id);
      const current = best.get(row.ownerId);
      if (current === undefined || score > current.score) {
        best.set(row.ownerId, { score, ord });
      }
    }
    after = batch[batch.length - 1]?.id ?? after;
    if (batch.length < SCAN_BATCH) break;
  }

  return [...best]
    .map(([id, v]) => ({ id, score: v.score, ord: v.ord }))
    .sort((a, b) => b.score - a.score)
    .slice(0, input.limit);
}
