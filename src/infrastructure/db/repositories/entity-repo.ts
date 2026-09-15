/**
 * 實體節點的寫入 —— **v0.5.0 之前沒有任何地方會建實體。**
 *
 * v0.2.0 的匯入只產生 `item`，v0.4.0 的裁決只動 `edge`。
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
import { identityKey, matchOf } from '../../../domain/entity/identity.js';

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

// ── 實體對齊──────────────────────────────────

/**
 * 一個實體的完整身分：本名 ＋ 別名 ＋ 有沒有被合併掉。
 *
 * 上面 `findEntitiesByNames` 只看本名，**而這一份是新的寫入路徑要用的** ——
 * 差別在於：「台灣積體電路製造（TSMC）」進來的時候，
 * 舊的那一支會建第二個實體，這一支會認出它就是既有的那個。
 */
export interface EntityRow {
  readonly id: string;
  readonly name: string;
  readonly type: EntityType;
  readonly aliases: readonly string[];
  readonly mergedInto: string | null;
}

function parseAliases(raw: unknown): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(String(raw ?? '[]'));
    if (!Array.isArray(parsed)) return [];
    // schema 寫的是 `[{name, lang, script}]`，而使用者手動加的可能只是字串。
    // **兩種都收** —— 一個壞掉的別名不該讓整個實體比對失效。
    return parsed
      .map((a) =>
        typeof a === 'string' ? a : String((a as Record<string, unknown>)?.['name'] ?? ''),
      )
      .filter((a) => a.length > 0);
  } catch {
    return [];
  }
}

function toEntity(row: Raw): EntityRow {
  return {
    id: String(row['id']),
    name: String(row['name_zh'] ?? ''),
    type: String(row['type']) as EntityType,
    aliases: parseAliases(row['aliases_json']),
    mergedInto:
      row['merged_into'] === null || row['merged_into'] === undefined
        ? null
        : String(row['merged_into']),
  };
}

/** 全部實體。**合併建議與比對都要一次看完**，而實體數遠小於節點數。 */
export function listEntities(db: DatabaseSync): readonly EntityRow[] {
  const rows = db
    .prepare('SELECT id, name_zh, type, aliases_json, merged_into FROM entity')
    .all() as Raw[];
  return rows.map(toEntity);
}

export function getEntity(db: DatabaseSync, id: string): EntityRow | null {
  const row = db
    .prepare('SELECT id, name_zh, type, aliases_json, merged_into FROM entity WHERE id = ?')
    .get(id) as Raw | undefined;
  return row === undefined ? null : toEntity(row);
}

/**
 * 把一個新抽出來的名字對到既有的實體 —— **本名、別名、括號裡的都算**。
 *
 * 這一支跟 `findEntitiesByNames` 的差別就是這一階段要解的問題本身：
 * 前者只認一模一樣的寫法，所以「TSMC」與「台灣積體電路製造（TSMC）」
 * 會變成兩個節點，而**兩個都低於投影門檻，於是圖上一個都沒有**。
 *
 * **仍然不做模糊比對。** 「台大」與「台大醫院」的編輯距離很近而它們是
 * 兩個東西；真正需要模糊的情況（音譯人名）靠的應該是 `wikidata_qid`。
 */
export function findEntityFor(
  entities: readonly EntityRow[],
  name: string,
  type: EntityType,
): EntityRow | null {
  const live = entities.filter((e) => e.mergedInto === null && e.type === type);
  for (const candidate of live) {
    if (matchOf({ name: candidate.name, aliases: candidate.aliases }, { name }) !== null) {
      return candidate;
    }
  }
  return null;
}

/** 記下一個新的寫法。**只增不改** —— 本名永遠是第一次建立時用的那個。 */
export function addAlias(db: DatabaseSync, id: string, alias: string, now: number): void {
  const row = getEntity(db, id);
  if (row === null) return;
  const trimmed = alias.trim();
  if (trimmed.length === 0 || trimmed === row.name) return;
  if (row.aliases.some((a) => identityKey(a) === identityKey(trimmed))) return;

  db.prepare('UPDATE entity SET aliases_json = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify([...row.aliases, trimmed]),
    now,
    id,
  );
}

/** 這一次合併動了哪一條邊的哪一端。**取消合併要靠它動回去。** */
export interface MovedEdge {
  readonly edgeId: string;
  readonly field: 'source' | 'target';
}

/**
 * 把 `mergedId` 併進 `keptId`。
 *
 * 三件事，而**沒有一件是刪除**：
 *
 * 1. 被併掉的那一列標上 `merged_into`（還在，看得到，取消得掉）
 * 2. 它的名字與別名進到留下來那一個的別名裡
 * 3. 它的邊改指到留下來的那一個，**而動了哪幾條記下來**
 *
 * ## 併完之後可能會出現兩條一模一樣的線
 *
 * A 與 B 都連到 X 而關係型別相同的時候，併完就有兩條 A→X。
 * **這裡刻意不合併它們**：合併兩條邊要決定它們的出處、狀態與裁決歷史
 * 怎麼處理，而那些決定沒有一個是可以自動做對的。
 * 兩條平行線看得見，使用者可以否決其中一條 —— **看得見的冗餘
 * 比看不見的資料遺失好**。
 */
export function mergeEntities(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly keptId: string;
    readonly mergedId: string;
    readonly reason: string;
    readonly now: number;
  },
): { readonly moved: readonly MovedEdge[]; readonly duplicates: number } {
  const kept = getEntity(db, input.keptId);
  const merged = getEntity(db, input.mergedId);
  if (kept === null || merged === null || kept.id === merged.id) {
    return { moved: [], duplicates: 0 };
  }

  const asSource = db
    .prepare("SELECT id, rel, target_id FROM edge WHERE source_kind = 'entity' AND source_id = ?")
    .all(merged.id) as Raw[];
  const asTarget = db
    .prepare("SELECT id, rel, source_id FROM edge WHERE target_kind = 'entity' AND target_id = ?")
    .all(merged.id) as Raw[];

  const existing = new Set(
    (
      db
        .prepare(
          `SELECT rel, source_id, target_id FROM edge
           WHERE (source_kind = 'entity' AND source_id = ?)
              OR (target_kind = 'entity' AND target_id = ?)`,
        )
        .all(kept.id, kept.id) as Raw[]
    ).map((r) => `${String(r['source_id'])}|${String(r['rel'])}|${String(r['target_id'])}`),
  );

  const moved: MovedEdge[] = [];
  let duplicates = 0;

  for (const row of asSource) {
    const id = String(row['id']);
    if (existing.has(`${kept.id}|${String(row['rel'])}|${String(row['target_id'])}`)) duplicates++;
    db.prepare('UPDATE edge SET source_id = ?, updated_at = ? WHERE id = ?').run(
      kept.id,
      input.now,
      id,
    );
    moved.push({ edgeId: id, field: 'source' });
  }
  for (const row of asTarget) {
    const id = String(row['id']);
    if (existing.has(`${String(row['source_id'])}|${String(row['rel'])}|${kept.id}`)) duplicates++;
    db.prepare('UPDATE edge SET target_id = ?, updated_at = ? WHERE id = ?').run(
      kept.id,
      input.now,
      id,
    );
    moved.push({ edgeId: id, field: 'target' });
  }

  for (const alias of [merged.name, ...merged.aliases]) addAlias(db, kept.id, alias, input.now);

  db.prepare('UPDATE entity SET merged_into = ?, merged_at = ?, updated_at = ? WHERE id = ?').run(
    kept.id,
    input.now,
    input.now,
    merged.id,
  );

  db.prepare(
    `INSERT INTO entity_merge (id, kept_id, merged_id, reason, moved_json, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.id, kept.id, merged.id, input.reason, JSON.stringify(moved), input.now);

  return { moved, duplicates };
}

/**
 * 取消合併。**照著紀錄動回去，不是靠猜。**
 *
 * 猜的版本會是「把所有 A 上跟 B 有關的邊還給 B」，
 * 而**那會把 A 本來就有的邊送給 B** —— 一個比原本的問題更難發現的錯。
 */
export function unmergeEntity(
  db: DatabaseSync,
  mergedId: string,
  now: number,
): { readonly restored: number } | null {
  const record = db
    .prepare(
      `SELECT id, kept_id, merged_id, moved_json FROM entity_merge
       WHERE merged_id = ? AND undone_at IS NULL ORDER BY at DESC LIMIT 1`,
    )
    .get(mergedId) as Raw | undefined;
  if (record === undefined) return null;

  let moved: MovedEdge[] = [];
  try {
    const parsed: unknown = JSON.parse(String(record['moved_json'] ?? '[]'));
    if (Array.isArray(parsed)) moved = parsed as MovedEdge[];
  } catch {
    moved = [];
  }

  for (const entry of moved) {
    const column = entry.field === 'source' ? 'source_id' : 'target_id';
    db.prepare(`UPDATE edge SET ${column} = ?, updated_at = ? WHERE id = ?`).run(
      mergedId,
      now,
      entry.edgeId,
    );
  }

  db.prepare(
    'UPDATE entity SET merged_into = NULL, merged_at = NULL, updated_at = ? WHERE id = ?',
  ).run(now, mergedId);
  db.prepare('UPDATE entity_merge SET undone_at = ? WHERE id = ?').run(now, String(record['id']));

  return { restored: moved.length };
}
