/**
 * 實體節點的寫入 —— **Stage 9 之前沒有任何地方會建實體。**
 *
 * Stage 6 的匯入只產生 `item`，Stage 8 的裁決只動 `edge`。
 * 實體是擴展抽出來的，所以這一份到現在才存在。
 *
 * ## 比對只看名字，不做同義詞
 *
 * `entityKey` 把大小寫與空白抹掉，其餘照原樣比。
 * **刻意不做同義詞、不做模糊比對** ——
 * 那會把兩個真的不同的東西合成一個，而合錯了沒有工具可以拆開
 * （`edge` 已經指過去了，`edge_evidence` 也是）。
 *
 * 代價寫在這裡：**同一個東西的兩種寫法會變成兩個節點。**
 * 跨語言那一邊的答案是 `wikidata_qid` 與 `aliases_json`
 * （`multilingual.md`），而那要等有真實的多語來源才填得出來。
 * 在那之前，**多一個節點比錯一個節點好** —— 前者看得見，後者看不見。
 */
import type { DatabaseSync } from 'node:sqlite';

import { entityKey, type EntityType } from '../../../domain/provider/index.js';

type Raw = Record<string, unknown>;

export interface EntityIdentity {
  readonly id: string;
  readonly name: string;
}

/**
 * 把一批名字對到既有的實體。
 *
 * **一次查完再比對，不是一個名字一次查詢** —— 20 個實體 × 每份文件
 * 在 5 萬筆規模下就是一個會被注意到的數字。
 */
export function findEntitiesByNames(
  db: DatabaseSync,
  names: readonly string[],
): ReadonlyMap<string, EntityIdentity> {
  const out = new Map<string, EntityIdentity>();
  if (names.length === 0) return out;
  const wanted = new Set(names.map(entityKey));
  const rows = db.prepare('SELECT id, name_zh FROM entity').all() as Raw[];
  for (const row of rows) {
    const name = String(row['name_zh'] ?? '');
    const key = entityKey(name);
    if (!wanted.has(key) || out.has(key)) continue;
    out.set(key, { id: String(row['id']), name });
  }
  return out;
}

export function insertEntity(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly type: EntityType;
    readonly name: string;
    readonly now: number;
  },
): void {
  db.prepare(
    `INSERT INTO entity (id, type, name_zh, title_rank, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.id, input.type, input.name, input.name, input.now, input.now);
}
