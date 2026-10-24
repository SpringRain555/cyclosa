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
  readonly typeManual?: boolean;
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
    typeManual: Number(row['type_manual'] ?? 0) === 1,
    aliases: parseAliases(row['aliases_json']),
    mergedInto:
      row['merged_into'] === null || row['merged_into'] === undefined
        ? null
        : String(row['merged_into']),
  };
}

/** 全部實體。**合併建議與比對都要一次看完**，而實體數遠小於節點數。 */
export function listEntities(db: DatabaseSync): readonly EntityRow[] {
  const rows = db.prepare('SELECT * FROM entity').all() as Raw[];
  return rows.map(toEntity);
}

export function getEntity(db: DatabaseSync, id: string): EntityRow | null {
  const row = db.prepare('SELECT * FROM entity WHERE id = ?').get(id) as Raw | undefined;
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
  const active = entities.filter((e) => e.mergedInto === null);
  // 人工改型別後，模型仍可能回傳舊型別；優先對回唯一的人工身分。
  const protectedMatches = new Map<string, EntityRow>();
  for (const candidate of entities) {
    if (
      !candidate.typeManual ||
      matchOf({ name: candidate.name, aliases: candidate.aliases }, { name }) === null
    )
      continue;
    const target =
      candidate.mergedInto === null ? candidate : active.find((e) => e.id === candidate.mergedInto);
    if (target !== undefined) protectedMatches.set(target.id, target);
  }
  // 已有明確的同型別身分時，不能因為另一個同名實體受保護就把兩者混在一起。
  const protectedTyped = [...protectedMatches.values()].find((e) => e.type === type);
  if (protectedTyped !== undefined) return protectedTyped;
  const live = active.filter((e) => e.type === type);
  // 取消合併後，原本名的身分優先於別人曾經吸收過的別名（也保護舊版紀錄）。
  const exact = live.find((e) => identityKey(e.name) === identityKey(name));
  if (exact !== undefined) return exact;
  for (const candidate of live) {
    if (matchOf({ name: candidate.name, aliases: candidate.aliases }, { name }) !== null) {
      return candidate;
    }
  }
  if (protectedMatches.size === 1) return [...protectedMatches.values()][0] ?? null;
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
    // 兩個待合併實體之間的原關聯保留原端點，避免改成資料庫禁止的自連線；取消時仍完整存在。
    if (String(row['target_id']) === kept.id) continue;
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
    if (String(row['source_id']) === kept.id) continue;
    const id = String(row['id']);
    if (existing.has(`${String(row['source_id'])}|${String(row['rel'])}|${kept.id}`)) duplicates++;
    db.prepare('UPDATE edge SET target_id = ?, updated_at = ? WHERE id = ?').run(
      kept.id,
      input.now,
      id,
    );
    moved.push({ edgeId: id, field: 'target' });
  }

  const beforeAliases = new Set(kept.aliases.map(identityKey));
  for (const alias of [merged.name, ...merged.aliases]) addAlias(db, kept.id, alias, input.now);
  const addedAliases = (getEntity(db, kept.id)?.aliases ?? []).filter(
    (alias) => !beforeAliases.has(identityKey(alias)),
  );

  db.prepare('UPDATE entity SET merged_into = ?, merged_at = ?, updated_at = ? WHERE id = ?').run(
    kept.id,
    input.now,
    input.now,
    merged.id,
  );

  db.prepare(
    `INSERT INTO entity_merge (id, kept_id, merged_id, reason, moved_json, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    kept.id,
    merged.id,
    JSON.stringify({ version: 2, reason: input.reason, addedAliases }),
    JSON.stringify(moved),
    input.now,
  );

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
  expectedMergeId?: string,
): { readonly restored: number } | null {
  const record = activeMergeRecord(db, mergedId);
  if (
    record === null ||
    !canUnmergeEntity(db, mergedId) ||
    (expectedMergeId !== undefined && record['id'] !== expectedMergeId)
  )
    return null;
  let moved: MovedEdge[];
  let addedAliases: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(record['moved_json']));
    if (
      !Array.isArray(parsed) ||
      parsed.some((edge: unknown) => {
        const e = edge as Partial<MovedEdge> | null;
        return (
          e === null ||
          typeof e !== 'object' ||
          typeof e.edgeId !== 'string' ||
          !['source', 'target'].includes(String(e.field))
        );
      })
    )
      return null;
    moved = parsed as MovedEdge[];
  } catch {
    return null;
  }
  // reason 原本是未限制的文字；新紀錄包入版本化的理由與別名差異。
  // moved_json 保持舊陣列格式，舊版程式仍能安全還原關聯。
  try {
    const metadata = JSON.parse(String(record['reason'])) as {
      version?: unknown;
      addedAliases?: unknown;
    };
    if (metadata?.version === 2) {
      if (
        !Array.isArray(metadata.addedAliases) ||
        metadata.addedAliases.some((alias: unknown) => typeof alias !== 'string')
      )
        return null;
      addedAliases = metadata.addedAliases as string[];
    }
  } catch {
    /* 舊版理由是一般文字，沒有足夠資訊安全推算吸收的別名。 */
  }
  const keptId = String(record['kept_id']);
  // 先驗全部端點，遇到後續改動或損壞紀錄時不能只還原一半。
  for (const entry of moved) {
    const column = entry.field === 'source' ? 'source_id' : 'target_id';
    const edge = db
      .prepare(`SELECT ${column} AS endpoint FROM edge WHERE id=?`)
      .get(entry.edgeId) as Raw | undefined;
    if (edge !== undefined && edge['endpoint'] !== keptId) return null;
  }
  let restored = 0;
  for (const entry of moved) {
    const column = entry.field === 'source' ? 'source_id' : 'target_id';
    restored += Number(
      db
        .prepare(`UPDATE edge SET ${column} = ?, updated_at = ? WHERE id = ?`)
        .run(mergedId, now, entry.edgeId).changes,
    );
  }
  if (addedAliases.length > 0) {
    const added = new Set(addedAliases.map(identityKey));
    const kept = getEntity(db, keptId);
    if (kept !== null)
      db.prepare('UPDATE entity SET aliases_json=?,updated_at=? WHERE id=?').run(
        JSON.stringify(kept.aliases.filter((alias) => !added.has(identityKey(alias)))),
        now,
        keptId,
      );
  }
  db.prepare(
    'UPDATE entity SET merged_into = NULL, merged_at = NULL, updated_at = ? WHERE id = ?',
  ).run(now, mergedId);
  db.prepare('UPDATE entity_merge SET undone_at = ? WHERE id = ?').run(now, String(record['id']));
  return { restored };
}

function activeMergeRecord(db: DatabaseSync, mergedId: string): Raw | null {
  return (
    (db
      .prepare(
        'SELECT rowid AS sequence, * FROM entity_merge WHERE merged_id=? AND undone_at IS NULL ORDER BY rowid DESC LIMIT 1',
      )
      .get(mergedId) as Raw | undefined) ?? null
  );
}
/** 吸收過別人的實體不能再被吸收，維持單層指向。 */
export function hasMergedChildren(db: DatabaseSync, entityId: string): boolean {
  return db.prepare('SELECT 1 FROM entity WHERE merged_into=? LIMIT 1').get(entityId) !== undefined;
}
/** 同一保留者依寫入順序逆序取消；不依系統時鐘排序。 */
export function canUnmergeEntity(db: DatabaseSync, mergedId: string): boolean {
  const record = activeMergeRecord(db, mergedId);
  if (record === null) return false;
  const kept = getEntity(db, String(record['kept_id']));
  const merged = getEntity(db, mergedId);
  if (kept === null || kept.mergedInto !== null || merged?.mergedInto !== kept.id) return false;
  return (
    db
      .prepare(
        'SELECT 1 FROM entity_merge WHERE kept_id=? AND undone_at IS NULL AND rowid>? LIMIT 1',
      )
      .get(kept.id, Number(record['sequence'])) === undefined
  );
}

export function activeMergeId(db: DatabaseSync, mergedId: string): string | null {
  const record = activeMergeRecord(db, mergedId);
  return record === null ? null : String(record['id']);
}

/** 僅由人工確認的整理操作與其復原呼叫。 */
export function setEntityType(
  db: DatabaseSync,
  id: string,
  type: EntityType,
  manual: boolean,
  now: number,
): void {
  db.prepare('UPDATE entity SET type = ?, type_manual = ?, updated_at = ? WHERE id = ?').run(
    type,
    manual ? 1 : 0,
    now,
    id,
  );
}
