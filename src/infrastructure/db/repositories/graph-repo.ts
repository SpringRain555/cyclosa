/**
 * 子圖的讀取。**這一份只讀不寫** —— 單條邊的讀寫與裁決在 `edge-repo.ts`。
 *
 * **snake_case ↔ camelCase 的轉換只在這一層做一次。**
 *
 * ## 一個會寫錯的地方：跳數算在哪一張圖上
 *
 * 資料庫存的是**二分圖**（`item` ↔ `entity`），但使用者看到的是**投影後的圖**。
 * 一個被 2 份文件提到的實體會被攤平成一條 `item—item` 的線，
 * **那條線在畫面上是一跳** —— 如果照資料庫的結構算，它會是兩跳。
 *
 * **所以走訪走的是投影後的圖**：低於展開門檻的實體是「透明的」，
 * 穿過它到達的文件跟穿過一條具名關係一樣，都是一跳。
 * 兩者不一致的話，工具列上的節點預算會系統性地低估。
 */
import type { DatabaseSync } from 'node:sqlite';

import {
  planProjection,
  projectionFor,
  type ComentionLine,
  type EntityType,
  type ProjectionThresholds,
  type SubgraphFilters,
  type EdgeLayer,
  type EdgeOrigin,
  type EdgeStatus,
  TIER_ORDER,
  TIER_CUTOFFS,
} from '../../../domain/graph/index.js';

type Raw = Record<string, unknown>;

/** SQLite 的變數上限很高，但一次塞幾千個沒有意義 —— 分批比較好讀也比較好排查。 */
const BATCH = 400;

function chunk<T>(items: readonly T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

// ── 型別 ────────────────────────────────────────────────────

export interface EntityRow {
  readonly id: string;
  readonly type: EntityType;
  readonly nameZh: string;
  readonly aliases: readonly { readonly name: string; readonly lang?: string }[];
  readonly wikidataQid: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface EdgeRow {
  readonly id: string;
  readonly layer: EdgeLayer;
  readonly rel: string;
  readonly sourceId: string;
  readonly sourceKind: 'item' | 'entity';
  readonly targetId: string;
  readonly targetKind: 'item' | 'entity';
  readonly origin: EdgeOrigin;
  readonly status: EdgeStatus;
  readonly confidence: number;
  readonly previouslyRejected: boolean;
  readonly createdAt: number;
}

function toEntity(row: Raw): EntityRow {
  let aliases: { name: string; lang?: string }[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row['aliases_json'] ?? '[]'));
    if (Array.isArray(parsed)) {
      aliases = parsed.map((a) => {
        const o = (a ?? {}) as Raw;
        const lang = o['lang'];
        return {
          name: String(o['name'] ?? ''),
          ...(typeof lang === 'string' ? { lang } : {}),
        };
      });
    }
  } catch {
    // 壞掉的 JSON 不該讓整張圖打不開 —— 別名只是別名
    aliases = [];
  }
  return {
    id: String(row['id']),
    type: String(row['type']) as EntityType,
    nameZh: String(row['name_zh'] ?? ''),
    aliases,
    wikidataQid: row['wikidata_qid'] === null ? null : String(row['wikidata_qid'] ?? '') || null,
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
  };
}

/**
 * `edge` 的一列 → `EdgeRow`。
 *
 * **`edge-repo.ts` 也用這一支** —— 寫入路徑讀回來的邊，跟子圖讀到的邊
 * 必須是同一個形狀。兩邊各寫一份映射的話，遲早有一邊少轉一個欄位，
 * 而那種錯不會丟例外，只會讓某個畫面上的數字是舊的。
 */
export function toEdge(row: Raw): EdgeRow {
  return {
    id: String(row['id']),
    layer: String(row['layer']) as EdgeLayer,
    rel: String(row['rel'] ?? ''),
    sourceId: String(row['source_id']),
    sourceKind: String(row['source_kind']) as 'item' | 'entity',
    targetId: String(row['target_id']),
    targetKind: String(row['target_kind']) as 'item' | 'entity',
    origin: String(row['origin']) as EdgeOrigin,
    status: String(row['status']) as EdgeStatus,
    confidence: Number(row['confidence'] ?? 0),
    previouslyRejected: Number(row['previously_rejected'] ?? 0) === 1,
    createdAt: Number(row['created_at']),
  };
}

// ── 篩選條件 → SQL ──────────────────────────────────────────

/**
 * 把篩選條件變成一段 WHERE。
 *
 * **`minTier` 在 SQL 裡是分數比較，不是字串比較** ——
 * 等級是顯示用的，存的一直是連續分數（glossary 的 `score` 那一條）。
 */
function edgeWhere(filters: SubgraphFilters): { sql: string; params: (string | number)[] } {
  const parts: string[] = [];
  const params: (string | number)[] = [];

  if (filters.statuses.length > 0) {
    parts.push(`status IN (${placeholders(filters.statuses.length)})`);
    params.push(...filters.statuses);
  }
  if (filters.layers.length > 0) {
    parts.push(`layer IN (${placeholders(filters.layers.length)})`);
    params.push(...filters.layers);
  }
  if (filters.minTier !== null) {
    // 等級 → 分數下限。`weak` 的下限是 0，所以那一級等於不篩。
    const floor =
      TIER_ORDER[filters.minTier] === TIER_ORDER.strong
        ? TIER_CUTOFFS.strong
        : TIER_ORDER[filters.minTier] === TIER_ORDER.medium
          ? TIER_CUTOFFS.medium
          : 0;
    if (floor > 0) {
      parts.push('confidence >= ?');
      params.push(floor);
    }
  }
  if (filters.since !== null) {
    parts.push('created_at >= ?');
    params.push(filters.since);
  }
  if (filters.until !== null) {
    parts.push('created_at <= ?');
    params.push(filters.until);
  }

  return { sql: parts.length > 0 ? ` AND ${parts.join(' AND ')}` : '', params };
}

// ── 基本查詢 ────────────────────────────────────────────────

export function nodeKindOf(db: DatabaseSync, id: string): 'item' | 'entity' | null {
  const item = db.prepare('SELECT 1 AS x FROM item WHERE id = ?').get(id) as Raw | undefined;
  if (item !== undefined) return 'item';
  const entity = db.prepare('SELECT 1 AS x FROM entity WHERE id = ?').get(id) as Raw | undefined;
  return entity === undefined ? null : 'entity';
}

/**
 * 打開關聯圖時鏡頭該落在哪。
 *
 * ui-workflows 說「鏡頭落在**起點節點**上」，而起點目前是一段文字不是節點。
 *
 * ## 為什麼不是「最近匯入的那一份」
 *
 * 那是最初的做法，而**第一次人工驗收就打臉了**：最後匯入的那一份剛好
 * 一條關聯都沒有，於是打開專題看到的是**畫面正中央一個孤零零的點**，
 * 三格跳數都寫著 1。技術上完全正確，但它讓人以為圖壞了。
 *
 * 所以改成**連得最多的那一個**：打開一張圖的時候，人要看的是
 * 「這堆東西長什麼樣」，而那個問題的答案在最密的地方，不在最新的地方。
 * 一條邊都沒有時才退回最近匯入的那一份。
 */
export function defaultFocusId(db: DatabaseSync): string | null {
  // 先問「哪幾個 item 的度數最高」。**只掃 edge 表**，不跟 item 做 OR join ——
  // 那種 join 在 20 萬條邊上用不到索引。
  const candidates = db
    .prepare(
      `SELECT id, SUM(n) AS deg FROM (
         SELECT source_id AS id, COUNT(*) AS n FROM edge
           WHERE source_kind = 'item' GROUP BY source_id
         UNION ALL
         SELECT target_id AS id, COUNT(*) AS n FROM edge
           WHERE target_kind = 'item' GROUP BY target_id
       ) GROUP BY id ORDER BY deg DESC LIMIT 8`,
    )
    .all() as Raw[];

  for (const candidate of candidates) {
    const id = String(candidate['id']);
    const row = db
      .prepare("SELECT 1 AS x FROM item WHERE id = ? AND status != 'excluded'")
      .get(id) as Raw | undefined;
    if (row !== undefined) return id;
  }

  const newest = db
    .prepare(
      `SELECT id FROM item WHERE status != 'excluded' ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get() as Raw | undefined;
  return newest === undefined ? null : String(newest['id']);
}

/** 專題共有幾個節點。工具列的「畫面上 N ／專題共 M」的 M。 */
export function totalNodeCount(db: DatabaseSync): number {
  const items = db.prepare("SELECT COUNT(*) AS n FROM item WHERE status != 'excluded'").get() as
    Raw | undefined;
  const entities = db.prepare('SELECT COUNT(*) AS n FROM entity').get() as Raw | undefined;
  return Number(items?.['n'] ?? 0) + Number(entities?.['n'] ?? 0);
}

export function totalEdgeCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM edge WHERE status != 'rejected'").get() as
    Raw | undefined;
  return Number(row?.['n'] ?? 0);
}

/**
 * 一批實體各自被幾份文件提到。
 *
 * ⚠️ **這個數字是全專題的，不受篩選條件影響。**
 * 同一個實體在不同的視角下必須長得一樣 —— 一個在這一屏是節點、
 * 換個篩選就變成一條線的實體，會讓人以為資料變了。
 */
export function mentionCounts(
  db: DatabaseSync,
  entityIds: readonly string[],
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const ids of chunk(entityIds)) {
    if (ids.length === 0) continue;
    const p = placeholders(ids.length);
    const rows = db
      .prepare(
        `SELECT ent, COUNT(DISTINCT itm) AS n FROM (
           SELECT target_id AS ent, source_id AS itm FROM edge
             WHERE target_kind = 'entity' AND source_kind = 'item' AND target_id IN (${p})
           UNION
           SELECT source_id AS ent, target_id AS itm FROM edge
             WHERE source_kind = 'entity' AND target_kind = 'item' AND source_id IN (${p})
         ) GROUP BY ent`,
      )
      .all(...([...ids, ...ids] as never[])) as Raw[];
    for (const row of rows) out.set(String(row['ent']), Number(row['n']));
  }
  // 一條邊都沒有的實體不會出現在上面的結果裡 —— 補 0，不要讓它變成 undefined
  for (const id of entityIds) if (!out.has(id)) out.set(id, 0);
  return out;
}

/** 提到這些實體的文件有哪些。攤平成線的時候要靠它找到線的兩端。 */
function itemsMentioning(
  db: DatabaseSync,
  entityIds: readonly string[],
  filters: SubgraphFilters,
): ReadonlyMap<string, string[]> {
  const where = edgeWhere(filters);
  const out = new Map<string, string[]>();
  for (const ids of chunk(entityIds)) {
    if (ids.length === 0) continue;
    const p = placeholders(ids.length);
    const rows = db
      .prepare(
        `SELECT target_id AS ent, source_id AS itm FROM edge
           WHERE target_kind = 'entity' AND source_kind = 'item' AND target_id IN (${p})${where.sql}
         UNION
         SELECT source_id AS ent, target_id AS itm FROM edge
           WHERE source_kind = 'entity' AND target_kind = 'item' AND source_id IN (${p})${where.sql}`,
      )
      .all(...([...ids, ...where.params, ...ids, ...where.params] as never[])) as Raw[];
    for (const row of rows) {
      const ent = String(row['ent']);
      const list = out.get(ent);
      if (list === undefined) out.set(ent, [String(row['itm'])]);
      else list.push(String(row['itm']));
    }
  }
  return out;
}

/** 一批節點各自往外連到哪裡。回的是「另一端的 id ＋ 那一端是什麼」。 */
function neighboursOf(
  db: DatabaseSync,
  ids: readonly string[],
  filters: SubgraphFilters,
): { id: string; kind: 'item' | 'entity' }[] {
  const where = edgeWhere(filters);
  const out: { id: string; kind: 'item' | 'entity' }[] = [];
  for (const batch of chunk(ids)) {
    if (batch.length === 0) continue;
    const p = placeholders(batch.length);
    const rows = db
      .prepare(
        `SELECT target_id AS other, target_kind AS other_kind FROM edge
           WHERE source_id IN (${p})${where.sql}
         UNION
         SELECT source_id AS other, source_kind AS other_kind FROM edge
           WHERE target_id IN (${p})${where.sql}`,
      )
      .all(...([...batch, ...where.params, ...batch, ...where.params] as never[])) as Raw[];
    for (const row of rows) {
      out.push({ id: String(row['other']), kind: String(row['other_kind']) as 'item' | 'entity' });
    }
  }
  return out;
}

// ── 走訪 ────────────────────────────────────────────────────

export interface Traversal {
  /** 索引 0 是焦點自己，索引 n 是第 n 跳新加進來的節點 */
  readonly idsByHop: readonly (readonly string[])[];
  /** 全部看得見的節點（含焦點）*/
  readonly visible: ReadonlySet<string>;
  /** 每個節點離焦點幾跳。**一跳鄰域只提亮不加框**要用它 */
  readonly hopOf: ReadonlyMap<string, number>;
  /** 攤平成線的實體 → 這一屏之內提到它的文件 */
  readonly projectedEntities: ReadonlyMap<string, string[]>;
  /** 展開成節點的實體 */
  readonly expandedEntities: ReadonlySet<string>;
  /**
   * 走到第幾跳就因為超過 `stopAfter` 而停下來的。`null` ＝ 走完了。
   *
   * **停下來之後的每一個數字都是下界，不是實際值** ——
   * 呼叫端要把這件事說出去，不能拿它當成一個數。
   */
  readonly truncatedAtHop: number | null;
}

/**
 * 這一批實體裡，哪幾個是某條**看得見的具名關係**的一端。
 *
 * **「看得見的」＝ 通過目前狀態篩選的** —— 已否決的邊預設不在篩選裡，
 * 所以一個只帶著被否決關係的實體不會因此被拉到畫面上。
 *
 * 用途是投影：帶著一條要人裁決的主張的實體**一律畫成節點**
 * （`projectionFor` 的檔頭寫了為什麼）。
 */
function entitiesCarryingNamedEdges(
  db: DatabaseSync,
  ids: readonly string[],
  filters: SubgraphFilters,
): ReadonlySet<string> {
  const out = new Set<string>();
  const where = edgeWhere({ ...filters, layers: ['named'] });
  for (const batch of chunk(ids)) {
    if (batch.length === 0) continue;
    const p = placeholders(batch.length);
    const rows = db
      .prepare(
        `SELECT source_id AS id FROM edge
           WHERE source_kind = 'entity' AND source_id IN (${p})${where.sql}
         UNION
         SELECT target_id AS id FROM edge
           WHERE target_kind = 'entity' AND target_id IN (${p})${where.sql}`,
      )
      .all(...([...batch, ...where.params, ...batch, ...where.params] as never[])) as Raw[];
    for (const row of rows) out.add(String(row['id']));
  }
  return out;
}

/**
 * 從焦點往外走 `maxHops` 跳。**只拿 id，不拿內容** ——
 * `/subgraph/size` 用的就是這一支，而它的效能預算是 50 ms。
 *
 * **焦點永遠看得見**，即使它是一個低於展開門檻的實體 ——
 * 使用者明確指定了它，投影門檻管的是「順便畫進來的東西」。
 */
/**
 * 從焦點往外走 `maxHops` 跳。
 *
 * ## `stopAfter`：走到看得見的節點超過這個數就停
 *
 * 2026-09-10 的規模量測（`docs/environment/performance.md`）：
 * 5 萬筆／20 萬關聯的合成資料上，從一個**中位數度數（3）**的節點走 3 跳
 * 會走到 **32,170 個節點、1,555 ms**；從樞紐走是 **54,318 個、4,566 ms**。
 * 而 `/subgraph/size` 的預算是 **50 ms**。
 *
 * **那個差距不是實作補得回來的** —— 走到 5.4 萬個節點這件事本身就不可能在
 * 50 ms 內做完。真正的問題是**它根本不需要走那麼遠**：
 * 超過 `RENDER_LIMIT` 的子圖一律回 413，所以「32,170」與「超過 8,000」
 * 對使用者是同一句話。第二句便宜得多。
 *
 * 所以這一支收一個上界，超過就停，並且**說出自己停了**（`truncatedAtHop`）。
 * 不說的話，呼叫端會把一個下界當成一個數 —— 那正是這個 repo 反覆修的那種錯。
 */
export function traverse(
  db: DatabaseSync,
  focusId: string,
  maxHops: number,
  filters: SubgraphFilters,
  thresholds: ProjectionThresholds,
  stopAfter: number = Number.POSITIVE_INFINITY,
): Traversal {
  const visible = new Set<string>([focusId]);
  const hopOf = new Map<string, number>([[focusId, 0]]);
  const idsByHop: string[][] = [[focusId]];
  const projectedEntities = new Map<string, string[]>();
  const expandedEntities = new Set<string>();
  let truncatedAtHop: number | null = null;

  let frontier: string[] = [focusId];

  for (let hop = 1; hop <= maxHops; hop += 1) {
    // **超過上界就不再往外走。** 剩下幾跳的數字補成目前的累計值，
    // 而 `truncatedAtHop` 讓呼叫端知道那些是下界。
    if (truncatedAtHop !== null || frontier.length === 0) {
      idsByHop.push([]);
      continue;
    }

    const fresh: string[] = [];

    /**
     * **一跳之內也要分段檢查，不能等這一跳做完。**
     *
     * 2026-09-10 第一版的上界只在跳與跳之間檢查，而量測顯示它幾乎沒有用：
     * 從一個**中位數度數（3）**的節點出發，第 2 跳結束時只有 1,922 個節點
     * （遠低於上界 8,000），而第 3 跳一口氣帶進 **32,170 個** ——
     * 爆炸整個發生在一跳之內，跳與跳之間的檢查看不到它。
     *
     * 分段之後最多只會多走一段（400 個），而不是多走一整跳。
     */
    for (const slice of chunk(frontier)) {
      const raw = neighboursOf(db, slice, filters);
      const entityIds = [...new Set(raw.filter((n) => n.kind === 'entity').map((n) => n.id))];
      const counts = mentionCounts(db, entityIds);
      const carrying = entitiesCarryingNamedEdges(db, entityIds, filters);

      const arrived: string[] = [];
      const transparent: string[] = [];

      for (const neighbour of raw) {
        if (neighbour.kind === 'item') {
          arrived.push(neighbour.id);
          continue;
        }
        const projection = projectionFor(
          counts.get(neighbour.id) ?? 0,
          thresholds,
          carrying.has(neighbour.id),
        );
        if (projection === 'node') {
          expandedEntities.add(neighbour.id);
          arrived.push(neighbour.id);
        } else if (projection === 'edge') {
          // **透明的**：它自己不畫，但穿過它到得了別的文件，而那算同一跳
          transparent.push(neighbour.id);
        }
        // `attribute` 是死路 —— 它只被一份文件提到，穿過去到不了任何新東西
      }

      if (transparent.length > 0) {
        const mentioning = itemsMentioning(db, [...new Set(transparent)], filters);
        for (const [entityId, itemIds] of mentioning) {
          for (const itemId of itemIds) arrived.push(itemId);
          const existing = projectedEntities.get(entityId);
          if (existing === undefined) projectedEntities.set(entityId, [...itemIds]);
          else existing.push(...itemIds);
        }
      }

      for (const id of arrived) {
        if (visible.has(id)) continue;
        visible.add(id);
        hopOf.set(id, hop);
        fresh.push(id);
      }

      if (visible.size > stopAfter) {
        truncatedAtHop = hop;
        break;
      }
    }

    idsByHop.push(fresh);
    frontier = fresh;
  }

  // 攤平出來的線只連得到看得見的東西 —— 走到上限之外的那些要剔掉
  for (const [entityId, itemIds] of projectedEntities) {
    const kept = [...new Set(itemIds)].filter((id) => visible.has(id));
    if (kept.length < 2) projectedEntities.delete(entityId);
    else projectedEntities.set(entityId, kept);
  }

  return { idsByHop, visible, hopOf, projectedEntities, expandedEntities, truncatedAtHop };
}

/** 走訪出來的實體要畫成什麼。**投影的判斷在 domain，這裡只餵資料。** */
export function projectionOf(
  traversal: Traversal,
  counts: ReadonlyMap<string, number>,
  thresholds: ProjectionThresholds,
): readonly ComentionLine[] {
  const entities = [...traversal.projectedEntities].map(([id, mentionedBy]) => ({
    id,
    mentionCount: counts.get(id) ?? mentionedBy.length,
    mentionedBy,
  }));
  return planProjection(entities, thresholds).lines;
}

// ── 內容 ────────────────────────────────────────────────────

export function loadEntities(db: DatabaseSync, ids: readonly string[]): readonly EntityRow[] {
  const out: EntityRow[] = [];
  for (const batch of chunk(ids)) {
    if (batch.length === 0) continue;
    const rows = db
      .prepare(`SELECT * FROM entity WHERE id IN (${placeholders(batch.length)})`)
      .all(...(batch as never[])) as Raw[];
    for (const row of rows) out.push(toEntity(row));
  }
  return out;
}

/**
 * 兩端都看得見的邊。
 *
 * **只有兩端都在畫面上的邊才畫** —— 一條連到看不見的東西的線
 * 在圖上是一條沒有終點的線，那比不畫更糟。
 */
export function loadEdgesAmong(
  db: DatabaseSync,
  ids: ReadonlySet<string>,
  filters: SubgraphFilters,
): readonly EdgeRow[] {
  const list = [...ids];
  const where = edgeWhere(filters);
  const seen = new Set<string>();
  const out: EdgeRow[] = [];

  for (const batch of chunk(list)) {
    if (batch.length === 0) continue;
    const p = placeholders(batch.length);
    const rows = db
      .prepare(`SELECT * FROM edge WHERE source_id IN (${p})${where.sql}`)
      .all(...([...batch, ...where.params] as never[])) as Raw[];
    for (const row of rows) {
      const edge = toEdge(row);
      if (!ids.has(edge.targetId) || seen.has(edge.id)) continue;
      seen.add(edge.id);
      out.push(edge);
    }
  }
  return out;
}

/** 一批邊各自的出處：幾筆、分別出自哪些 `item`。 */
export function evidenceOf(
  db: DatabaseSync,
  edgeIds: readonly string[],
): ReadonlyMap<string, { count: number; itemIds: string[]; hasQuote: boolean }> {
  const out = new Map<string, { count: number; itemIds: string[]; hasQuote: boolean }>();
  for (const batch of chunk(edgeIds)) {
    if (batch.length === 0) continue;
    const rows = db
      .prepare(
        `SELECT edge_id, item_id, quote FROM edge_evidence
           WHERE edge_id IN (${placeholders(batch.length)})`,
      )
      .all(...(batch as never[])) as Raw[];
    for (const row of rows) {
      const key = String(row['edge_id']);
      const entry = out.get(key) ?? { count: 0, itemIds: [], hasQuote: false };
      entry.count += 1;
      entry.itemIds.push(String(row['item_id']));
      if (String(row['quote'] ?? '').trim().length > 0) entry.hasQuote = true;
      out.set(key, entry);
    }
  }
  return out;
}

/**
 * 互為轉載的文件分群 —— **獨立來源數就是靠這個算的**（ADR-0015）。
 *
 * 「出處 5 筆」可能只有 2 個獨立來源，如果其中三筆是同一則的轉載。
 * 這裡回的是連通分量，分群本身在 `domain/graph/confidence.ts`。
 */
export function derivedGroups(
  db: DatabaseSync,
  itemIds: readonly string[],
): readonly (readonly string[])[] {
  const unique = [...new Set(itemIds)];
  if (unique.length < 2) return [];

  // union-find
  const parent = new Map<string, string>(unique.map((id) => [id, id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root) as string;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur) as string;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const batch of chunk(unique)) {
    const p = placeholders(batch.length);
    const rows = db
      .prepare(
        `SELECT source_id, target_id FROM edge
           WHERE layer = 'derived' AND source_kind = 'item' AND target_kind = 'item'
             AND (source_id IN (${p}) OR target_id IN (${p}))`,
      )
      .all(...([...batch, ...batch] as never[])) as Raw[];
    for (const row of rows) {
      const a = String(row['source_id']);
      const b = String(row['target_id']);
      if (parent.has(a) && parent.has(b)) union(a, b);
    }
  }

  const groups = new Map<string, string[]>();
  for (const id of unique) {
    const root = find(id);
    const list = groups.get(root);
    if (list === undefined) groups.set(root, [id]);
    else list.push(id);
  }
  // 只有一個成員的群不是「轉載群」，不必回去
  return [...groups.values()].filter((g) => g.length > 1);
}
