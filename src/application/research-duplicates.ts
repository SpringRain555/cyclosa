/**
 * 這次研究的候選裡，哪幾個可能跟專題裡已有的、或這次另一個候選是同一篇（2026-10-28 試用回饋 8）。
 *
 * **畫面（`research-view`）與建圖（`research-build`）用同一支算** —— 「可能重複」會改預設
 * （`defaultDecision` 回不進圖），兩邊各算各的就可能出現畫面寫「不進圖」、建圖卻抽了它。
 *
 * 認法在 `domain/research/duplicates.ts`。這一支只負責把資料庫裡的東西排好交給它：
 *
 * - **專題裡已有的** ＝ 不是這次候選抓回來的那幾份（點註不算）
 * - 候選的標題給兩個：搜尋結果上的、抓回來那一頁的
 * - 內容一模一樣的（擷取時已經認出來、記成 `FETCH_DUPLICATE`）而那一份在這次研究之前就在：直接算「專題裡已經有」
 */
import {
  findDuplicates,
  type DuplicateOf,
  type DuplicateSubject,
} from '../domain/research/duplicates.js';
import type { DatabaseSync } from '../infrastructure/db/database.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import type { ResearchCandidateRow } from '../infrastructure/db/repositories/research-repo.js';

export function candidateDuplicates(
  db: DatabaseSync,
  candidates: readonly ResearchCandidateRow[],
  researchCreatedAt: number,
): ReadonlyMap<string, DuplicateOf> {
  const identities = items.listItemIdentities(db);
  const own = new Set(candidates.flatMap((c) => (c.itemId === null ? [] : [c.itemId])));
  const titleOf = new Map(identities.map((i) => [i.id, i.title]));
  const createdAtOf = new Map(identities.map((i) => [i.id, i.createdAt]));

  const existing: DuplicateSubject[] = identities
    .filter((i) => !own.has(i.id))
    .map((i) => ({ id: i.id, url: i.url, titles: [i.title] }));

  const out = new Map<string, DuplicateOf>(
    findDuplicates(
      existing,
      candidates.map((c) => ({
        id: c.id,
        url: c.url,
        titles: [c.title, ...(c.itemId === null ? [] : [titleOf.get(c.itemId) ?? ''])],
        fetched: c.acquisition === 'fetched' || c.acquisition === 'uploaded',
      })),
    ),
  );

  // 內容一模一樣、而那一份在這次研究之前就在 —— 擷取層已經認出來了，這裡只是把它說成「已經有」。
  for (const c of candidates) {
    if (out.has(c.id) || c.code !== 'FETCH_DUPLICATE' || c.itemId === null) continue;
    const createdAt = createdAtOf.get(c.itemId);
    if (createdAt !== undefined && createdAt < researchCreatedAt) {
      out.set(c.id, { id: c.itemId, kind: 'item', reason: 'content' });
    }
  }
  return out;
}

/** 候選加上 `duplicate`，交給 `effectiveDecision`／`tallyDirection`。 */
export function withDuplicateFlags<T extends { readonly id: string }>(
  candidates: readonly T[],
  duplicates: ReadonlyMap<string, DuplicateOf>,
): (T & { readonly duplicate: boolean })[] {
  return candidates.map((c) => ({ ...c, duplicate: duplicates.has(c.id) }));
}
