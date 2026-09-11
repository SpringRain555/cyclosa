/**
 * 子圖的用例。
 *
 * **這一層算完才送出去** —— 投影、可信度等級、獨立來源數三件事
 * 全部在伺服器端算好（`graph-view.md`）。理由是同一條：
 * 兩份實作遲早不一致，而不一致的那一份會安靜地給出錯的答案。
 *
 * **沒有「整張圖」的用例。** 連函式都沒有（ADR-0008）。
 */
import { join } from 'node:path';

import {
  countIndependentSources,
  DEFAULT_PROJECTION_THRESHOLDS,
  edgeLineFor,
  foldDerived,
  isValidThresholds,
  MAX_HOPS,
  NODE_BUDGET,
  nodeGlyphFor,
  overBudgetHops,
  RENDER_LIMIT,
  tierOf,
  type ConfidenceTier,
  type EdgeLayer,
  type EdgeOrigin,
  type EdgeStatus,
  type HopCounts,
  type ProjectionThresholds,
  type SubgraphFilters,
} from '../domain/graph/index.js';
import type { ItemKind } from '../domain/ingest/state.js';
import { openCaseDatabase, type DatabaseSync } from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as graph from '../infrastructure/db/repositories/graph-repo.js';
import { loadItems } from '../infrastructure/db/repositories/item-repo.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';

const CASE_DB_FILE = 'case.sqlite';

async function withCase<T>(
  dataRoot: string,
  slug: string,
  body: (db: DatabaseSync) => Result<T>,
): Promise<Result<T>> {
  const cid = correlationId();
  const opened = await openCaseDatabase(join(casesDir(dataRoot), slug, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new')
    return err('CASE_SCHEMA_TOO_NEW', cid, { found: opened.found });
  if (opened.kind === 'migrate-failed')
    return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { at: opened.at });
  if (opened.kind === 'missing') return err('CASE_NOT_FOUND', cid, { slug });

  try {
    if (readCase(opened.db) === null) return err('CASE_NOT_FOUND', cid, { slug });
    return body(opened.db);
  } finally {
    opened.db.close();
  }
}

export interface SubgraphQuery {
  readonly focus: string | null;
  readonly hops: number;
  readonly filters: SubgraphFilters;
  readonly thresholds: ProjectionThresholds;
}

/** 圖上的一個點。**`node` 這個字只有在明確指「圖上的一個點」時才用**（glossary）。 */
export interface SubgraphNode {
  readonly id: string;
  readonly kind: 'item' | 'entity';
  /** `item.kind` 或 `entity.type` */
  readonly subKind: string;
  readonly title: string;
  /** 離焦點幾跳。**一跳鄰域只提亮不加框**要用它 */
  readonly hop: number;
  readonly lang: string | null;
  /** 已讀是**正交旗標**，不是狀態 */
  readonly readAt: number | null;
  readonly excluded: boolean;
  readonly lowConfidence: boolean;
  readonly excerpt: string;
  /** 實體被幾份文件提到（全專題）。`item` 是 `null` */
  readonly mentionCount: number | null;
  /** 摺進這個節點的轉載數（「＋3 轉載」）。**看不到就會以為資料漏了** */
  readonly derivedFolded: number;
  readonly hollow: boolean;
}

export interface SubgraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly layer: EdgeLayer;
  readonly rel: string;
  readonly status: EdgeStatus;
  readonly origin: EdgeOrigin;
  /** **只用於排序與線寬，前端永遠不顯示這個小數** */
  readonly confidence: number;
  readonly tier: ConfidenceTier;
  readonly evidenceCount: number;
  /** 「出處 5 筆 · 2 個獨立來源」的那個 2 */
  readonly independentSourceCount: number;
  readonly hasDirectQuote: boolean;
  readonly previouslyRejected: boolean;
  /** 共同提及線中點那個方塊是哪個實體。其餘的層是 `null` */
  readonly via: string | null;
  /** **投影出來的，資料庫裡沒有這一列** —— 它不能被拿去做任何寫入 */
  readonly synthetic: boolean;
  readonly dashed: boolean;
  readonly crossed: boolean;
  readonly directional: boolean;
  readonly folded: boolean;
}

export interface SubgraphPayload {
  readonly focus: string;
  readonly hops: number;
  readonly nodes: readonly SubgraphNode[];
  readonly edges: readonly SubgraphEdge[];
  /** 畫面上 N ／專題共 M */
  readonly visibleNodeCount: number;
  readonly totalNodeCount: number;
  readonly totalEdgeCount: number;
  readonly budget: number;
  readonly overBudget: boolean;
  readonly thresholds: ProjectionThresholds;
}

/**
 * 焦點。**必填** —— 沒有焦點的查詢就是整張圖，而那個東西不存在。
 *
 * 打開分頁時前端沒有焦點可給，所以有這一支：**它回一個起點，不回一張圖。**
 */
export async function defaultFocus(
  dataRoot: string,
  slug: string,
): Promise<Result<{ readonly focus: string | null; readonly totalNodeCount: number }>> {
  return withCase(dataRoot, slug, (db) =>
    ok(
      { focus: graph.defaultFocusId(db), totalNodeCount: graph.totalNodeCount(db) },
      correlationId(),
    ),
  );
}

/**
 * 每一格跳數會帶進幾個節點。**只數不拉資料**（效能預算 50 ms，Stage 13 量測）。
 *
 * 工具列的跳數格用它**在使用者按下去之前**就顯示代價 ——
 * 「把跳數變成節點預算，那個常數就不再是拍出來的」。
 */
export async function subgraphSize(
  dataRoot: string,
  slug: string,
  query: SubgraphQuery,
): Promise<Result<HopCounts>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    const focus = query.focus ?? graph.defaultFocusId(db);
    if (focus === null) return err('GRAPH_NODE_NOT_FOUND', cid, { why: 'empty-case' });
    if (graph.nodeKindOf(db, focus) === null) return err('GRAPH_NODE_NOT_FOUND', cid, { focus });

    const thresholds = isValidThresholds(query.thresholds)
      ? query.thresholds
      : DEFAULT_PROJECTION_THRESHOLDS;
    /**
     * **走到硬上限就停。**
     *
     * 這一支的預算是 50 ms，而 2026-09-10 的規模量測（5 萬筆／20 萬關聯）
     * 顯示走完 3 跳要 **1,555 ms（中位數度數的焦點）到 4,566 ms（樞紐）**——
     * 因為 3 跳鄰域是 3.2 萬到 5.4 萬個節點。
     *
     * 那個差距補不回來，而**它也不需要補**：超過 `RENDER_LIMIT` 的子圖
     * 一律回 413，所以精確的「32,170」不會改變使用者的任何一個決定。
     */
    const traversal = graph.traverse(db, focus, MAX_HOPS, query.filters, thresholds, RENDER_LIMIT);

    // 累計 —— 「2 跳會帶進 143 個」指的是總共看得到 143 個，不是第 2 跳新增 143 個
    const counts: Record<string, number> = {};
    const capped: string[] = [];
    let running = traversal.idsByHop[0]?.length ?? 1;
    for (let hop = 1; hop <= MAX_HOPS; hop += 1) {
      running += traversal.idsByHop[hop]?.length ?? 0;
      counts[String(hop)] = running;
      // 停下來那一跳**自己也是下界** —— 它是「超過上限」才停的，
      // 所以它的數字已經不是走完會有的那個數字。
      if (traversal.truncatedAtHop !== null && hop >= traversal.truncatedAtHop) {
        capped.push(String(hop));
      }
    }

    return ok({ counts, budget: NODE_BUDGET, overBudget: overBudgetHops(counts), capped }, cid);
  });
}

/**
 * 子圖本身。
 *
 * **超過渲染上限時回 `GRAPH_SUBGRAPH_TOO_LARGE`（413），不是回一個巨大的結果** ——
 * 而更好的做法是讓它不要發生，那就是上面那支端點存在的理由。
 */
export async function subgraph(
  dataRoot: string,
  slug: string,
  query: SubgraphQuery,
): Promise<Result<SubgraphPayload>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    const focus = query.focus ?? graph.defaultFocusId(db);
    if (focus === null) return err('GRAPH_NODE_NOT_FOUND', cid, { why: 'empty-case' });
    if (graph.nodeKindOf(db, focus) === null) return err('GRAPH_NODE_NOT_FOUND', cid, { focus });

    const thresholds = isValidThresholds(query.thresholds)
      ? query.thresholds
      : DEFAULT_PROJECTION_THRESHOLDS;

    // 一樣帶上界 —— 超過就是 413，**多走的那些節點是白走的**。
    //
    // **但省下來的沒有想像中多**（2026-09-10 實測）：`hops` 是 2 的時候
    // 本來就只走兩跳，而樞紐的爆炸發生在第 1、2 跳自己身上 ——
    // 上界救得到的是「還會不會有第 3 跳」，不是這一跳本身。
    // 真正把樞紐 2 跳壓下來的是**跳內分段**（見 `traverse`），不是這一行。
    const traversal = graph.traverse(
      db,
      focus,
      query.hops,
      query.filters,
      thresholds,
      RENDER_LIMIT,
    );
    if (traversal.visible.size > RENDER_LIMIT || traversal.truncatedAtHop !== null) {
      return err('GRAPH_SUBGRAPH_TOO_LARGE', cid, {
        found: traversal.visible.size,
        limit: RENDER_LIMIT,
      });
    }

    const realEdges = graph.loadEdgesAmong(db, traversal.visible, query.filters);
    const folded = foldDerived(
      realEdges.map((e) => ({ source: e.sourceId, target: e.targetId, layer: e.layer })),
    );

    // ── 節點 ────────────────────────────────────────────────
    const ids = [...traversal.visible];
    const entityIds = ids.filter((id) => traversal.expandedEntities.has(id) || id === focus);
    const items = loadItems(db, ids);
    const itemIds = new Set(items.map((i) => i.id));
    const entities = graph.loadEntities(
      db,
      entityIds.filter((id) => !itemIds.has(id)),
    );
    const counts = graph.mentionCounts(
      db,
      entities.map((e) => e.id),
    );

    const nodes: SubgraphNode[] = [];
    for (const item of items) {
      nodes.push({
        id: item.id,
        kind: 'item',
        subKind: item.kind,
        title: item.title,
        hop: traversal.hopOf.get(item.id) ?? 0,
        lang: item.lang,
        readAt: item.readAt,
        excluded: item.status === 'excluded',
        lowConfidence: item.lowConfidence,
        excerpt: item.excerpt,
        mentionCount: null,
        derivedFolded: folded.get(item.id) ?? 0,
        hollow: nodeGlyphFor({ kind: 'item', itemKind: item.kind as ItemKind }).hollow,
      });
    }
    for (const entity of entities) {
      nodes.push({
        id: entity.id,
        kind: 'entity',
        subKind: entity.type,
        title: entity.nameZh,
        hop: traversal.hopOf.get(entity.id) ?? 0,
        lang: null,
        readAt: null,
        excluded: false,
        lowConfidence: false,
        excerpt: '',
        mentionCount: counts.get(entity.id) ?? 0,
        derivedFolded: folded.get(entity.id) ?? 0,
        hollow: true,
      });
    }

    // ── 邊 ──────────────────────────────────────────────────
    const evidence = graph.evidenceOf(
      db,
      realEdges.map((e) => e.id),
    );
    const allEvidenceItems = [...evidence.values()].flatMap((e) => e.itemIds);
    const groups = graph.derivedGroups(db, allEvidenceItems);

    const edges: SubgraphEdge[] = realEdges.map((edge) => {
      const line = edgeLineFor(edge.layer, edge.status);
      const ev = evidence.get(edge.id);
      const sources = (ev?.itemIds ?? []).map((itemId) => ({ itemId }));
      return {
        id: edge.id,
        source: edge.sourceId,
        target: edge.targetId,
        layer: edge.layer,
        rel: edge.rel,
        status: edge.status,
        origin: edge.origin,
        confidence: edge.confidence,
        tier: tierOf(edge.confidence),
        evidenceCount: ev?.count ?? 0,
        independentSourceCount: countIndependentSources(sources, groups),
        hasDirectQuote: ev?.hasQuote ?? false,
        previouslyRejected: edge.previouslyRejected,
        via: null,
        synthetic: false,
        dashed: line.dashed,
        crossed: line.crossed,
        directional: line.directional,
        folded: line.drawing === 'folded',
      };
    });

    // ── 投影出來的共同提及線 ────────────────────────────────
    // **它們不在資料庫裡。** id 加 `proj:` 前綴，讓任何把它當成真邊
    // 送去寫入的程式在第一步就找不到那一列。
    const projectionCounts = graph.mentionCounts(db, [...traversal.projectedEntities.keys()]);
    for (const line of graph.projectionOf(traversal, projectionCounts, thresholds)) {
      edges.push({
        id: `proj:${line.entityId}:${line.a}:${line.b}`,
        source: line.a,
        target: line.b,
        layer: 'comention',
        rel: 'comention',
        status: 'pending',
        origin: 'machine',
        confidence: 0,
        tier: 'weak',
        evidenceCount: 0,
        independentSourceCount: 0,
        hasDirectQuote: false,
        previouslyRejected: false,
        via: line.entityId,
        synthetic: true,
        dashed: false,
        crossed: false,
        directional: false,
        folded: false,
      });
    }

    return ok(
      {
        focus,
        hops: query.hops,
        nodes,
        edges,
        visibleNodeCount: nodes.length,
        totalNodeCount: graph.totalNodeCount(db),
        totalEdgeCount: graph.totalEdgeCount(db),
        budget: NODE_BUDGET,
        overBudget: nodes.length > NODE_BUDGET,
        thresholds,
      },
      cid,
    );
  });
}
