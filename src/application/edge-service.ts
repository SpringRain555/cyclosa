/**
 * 關聯與出處的用例 —— **人工裁決**（Stage 8）。
 *
 * `graph-service.ts` 回的是「一屏長什麼樣」，這一份回的是
 * 「**這一條到底憑什麼**，而我可以對它做什麼」。
 *
 * ## 三件事在這一層算完才送出去
 *
 * 獨立來源數、可信度等級、校準比例 —— 跟子圖一樣的理由（`graph-view.md`）：
 * 前端手上永遠只有一屏，它沒有資料可以自己算。
 *
 * ## 一條規則貫穿整份：機器永遠不得覆寫人工判定
 *
 * 它在這裡有**四個**互相獨立的實作，而那不是重複：
 *
 * | 在哪 | 擋什麼 |
 * |---|---|
 * | `trg_edge_human_row_immutable` | 任何人改到 `origin='human'` 的欄位 |
 * | `machineMayUpdateStatus` | 重跑動到被人碰過的邊 |
 * | `evaluateProposal` | 重跑把否決過的東西再提一次 |
 * | `mayAdjudicate` | 人裁決一條**下次重算就會被蓋掉**的邊 |
 *
 * 最後那一條是反過來的 —— 它保護的是人的判斷不被機器蓋掉，
 * 做法是**不讓那個判斷一開始就發生**。
 */
import { join } from 'node:path';

import {
  actionsFrom,
  calibrationOf,
  countIndependentSources,
  edgePanelFieldsFor,
  mayAdjudicate,
  requiresAdjudication,
  tierOf,
  transition,
  type Calibration,
  type ConfidenceTier,
  type EdgeAction,
  type EdgeLayer,
  type EdgeOrigin,
  type EdgePanelFields,
  type EdgeStatus,
} from '../domain/graph/index.js';
import {
  openCaseDatabase,
  withTransaction,
  type DatabaseSync,
} from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as edges from '../infrastructure/db/repositories/edge-repo.js';
import * as graph from '../infrastructure/db/repositories/graph-repo.js';
import { loadItems } from '../infrastructure/db/repositories/item-repo.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';

const CASE_DB_FILE = 'case.sqlite';
const QUEUE_LIMIT = 50;

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

  try {
    if (readCase(opened.db) === null) return err('CASE_NOT_FOUND', cid, { slug });
    return body(opened.db);
  } finally {
    opened.db.close();
  }
}

/** 節點 id → 標題。**面板上不會出現 id** —— 使用者不認得它。 */
function titlesOf(db: DatabaseSync, ids: readonly string[]): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const item of loadItems(db, ids)) out.set(item.id, item.title);
  for (const entity of graph.loadEntities(
    db,
    ids.filter((id) => !out.has(id)),
  )) {
    out.set(entity.id, entity.nameZh);
  }
  return out;
}

// ── 一條邊的細節 ────────────────────────────────────────────

export interface EvidenceView {
  readonly id: string;
  readonly itemId: string;
  readonly itemTitle: string;
  readonly quote: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly createdAt: number;
}

export interface AuditView {
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly action: string;
  readonly actor: 'human' | 'machine';
  readonly at: number;
}

export interface EdgeDetail {
  readonly id: string;
  readonly layer: EdgeLayer;
  readonly rel: string;
  readonly source: string;
  readonly sourceTitle: string;
  readonly target: string;
  readonly targetTitle: string;
  readonly status: EdgeStatus;
  readonly origin: EdgeOrigin;
  readonly tier: ConfidenceTier;
  readonly evidenceCount: number;
  readonly independentSourceCount: number;
  readonly hasDirectQuote: boolean;
  readonly previouslyRejected: boolean;
  readonly createdAt: number;
  readonly evidence: readonly EvidenceView[];
  readonly audit: readonly AuditView[];
  /** 現在按得下去的動作。**空陣列代表這條邊不進裁決** */
  readonly actions: readonly EdgeAction[];
  readonly adjudicable: boolean;
  /**
   * 面板上哪幾欄有意義。**規則在 domain，不在元件裡** ——
   * 它原本是四個 `v-if`，而一條規則寫在四個地方就是四個各自會漂的地方
   * （`render-rules.ts` 的 `edgePanelFieldsFor`）。
   */
  readonly fields: EdgePanelFields;
  /**
   * 「確認」現在按不下去，因為它是機器建的而且一筆出處都沒有。
   *
   * **先說再按，不要按了才報錯** —— 這個限制是可以事先知道的，
   * 而一個按下去才告訴你不行的按鈕，使用者第二次就不會相信其他按鈕了。
   */
  readonly confirmNeedsEvidence: boolean;
  readonly calibration: Calibration;
}

function detailOf(db: DatabaseSync, edge: graph.EdgeRow): EdgeDetail {
  const evidence = edges.evidenceRows(db, edge.id);
  const groups = graph.derivedGroups(
    db,
    evidence.map((e) => e.itemId),
  );
  const titles = titlesOf(db, [edge.sourceId, edge.targetId]);
  const adjudicable = mayAdjudicate({ layer: edge.layer, origin: edge.origin });
  const confirmNeedsEvidence = edge.origin === 'machine' && evidence.length < 1;

  return {
    id: edge.id,
    layer: edge.layer,
    rel: edge.rel,
    source: edge.sourceId,
    sourceTitle: titles.get(edge.sourceId) ?? edge.sourceId,
    target: edge.targetId,
    targetTitle: titles.get(edge.targetId) ?? edge.targetId,
    status: edge.status,
    origin: edge.origin,
    tier: tierOf(edge.confidence),
    evidenceCount: evidence.length,
    independentSourceCount: countIndependentSources(evidence, groups),
    hasDirectQuote: evidence.some((e) => e.quote.trim().length > 0),
    previouslyRejected: edge.previouslyRejected,
    createdAt: edge.createdAt,
    evidence: evidence.map((e) => ({
      id: e.id,
      itemId: e.itemId,
      itemTitle: e.itemTitle,
      quote: e.quote,
      charStart: e.charStart,
      charEnd: e.charEnd,
      createdAt: e.createdAt,
    })),
    audit: edges.auditOf(db, edge.id).map((a) => ({
      fromStatus: a.fromStatus,
      toStatus: a.toStatus,
      action: a.action,
      actor: a.actor,
      at: a.at,
    })),
    actions: adjudicable ? actionsFrom(edge.status) : [],
    adjudicable,
    fields: edgePanelFieldsFor({ layer: edge.layer, origin: edge.origin }),
    confirmNeedsEvidence,
    /**
     * **校準比例是分段的**（ADR-0017 的「段」＝ `rel` × 可信度等級）。
     *
     * 那一份的「考慮過但沒選的」**明確否決了全域平均**：
     * 「全域平均對每一條關聯給同一個數字，等於沒有資訊」。
     * 第一版寫成全域的，而**測試沒有抓到** —— 因為餵進去的 30 條
     * 剛好各有各的 `rel`，分不分段的結果在那批資料上看起來一樣合理。
     */
    calibration: calibrationOf(
      edges.latestHumanVerdicts(db, { rel: edge.rel, tier: tierOf(edge.confidence) }),
    ),
  };
}

export async function getEdge(
  dataRoot: string,
  slug: string,
  edgeId: string,
): Promise<Result<EdgeDetail>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    const edge = edges.getEdge(db, edgeId);
    if (edge === null) return err('GRAPH_EDGE_NOT_FOUND', cid, { edgeId });
    return ok(detailOf(db, edge), cid);
  });
}

// ── 手動建立 ────────────────────────────────────────────────

export interface CreateEdgeInput {
  readonly source: string;
  readonly target: string;
  readonly rel: string;
  readonly layer: EdgeLayer;
}

/**
 * 手動建立一條關聯。**一建立就是「已確認」＋ `origin='human'`**（api-contract）。
 *
 * 沒有 `edge_evidence` —— **出處就是那個人**，而那件事由 `origin` 記著。
 * `trg_edge_confirm_requires_evidence_*` 的條件是 `origin='machine'`，
 * 所以這條路走得通，而機器那條走不通。**那個不對稱就是這條規則本身。**
 */
export async function createEdge(
  dataRoot: string,
  slug: string,
  input: CreateEdgeInput,
): Promise<Result<EdgeDetail>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();

    if (input.source === input.target) return err('GRAPH_SELF_EDGE', cid);

    const rel = input.rel.trim();
    // **具名關係一定要有名字。** 另外三層的 `rel` 是機器用的固定字串
    // （`轉載`、`提到`、`similar`），使用者不必自己想一個
    if (rel.length === 0 && requiresAdjudication(input.layer)) {
      return err('GRAPH_REL_EMPTY', cid, { layer: input.layer });
    }

    const sourceKind = graph.nodeKindOf(db, input.source);
    if (sourceKind === null) return err('GRAPH_NODE_NOT_FOUND', cid, { id: input.source });
    const targetKind = graph.nodeKindOf(db, input.target);
    if (targetKind === null) return err('GRAPH_NODE_NOT_FOUND', cid, { id: input.target });

    const ref = { source: input.source, target: input.target, rel };
    if (edges.findByTriple(db, ref) !== null) {
      // **同一個主張存兩列會讓獨立來源數重複計算** ——
      // 那個數字是這個工具最不能出錯的一個
      return err('GRAPH_EDGE_EXISTS', cid, ref);
    }

    const id = withTransaction(db, () =>
      edges.insertEdge(
        db,
        {
          ...ref,
          layer: input.layer,
          sourceKind,
          targetKind,
          origin: 'human',
          // 人建的邊沒有「可信度分數」可言 —— 那是機器抽取器的輸出。
          // 給 1 是因為線寬要畫得出來，而**人親手連的線本來就該最粗**
          confidence: 1,
        },
        Date.now(),
      ),
    );

    const created = edges.getEdge(db, id);
    if (created === null) return err('GRAPH_UNEXPECTED', cid, { why: 'insert-vanished' });
    return ok(detailOf(db, created), cid);
  });
}

// ── 六條轉移 ────────────────────────────────────────────────

/**
 * 一次裁決。**六條轉移都走這一支**（api-contract）。
 *
 * 順序是刻意的：**先問「這條邊該不該被裁決」，再問「這個動作合不合法」。**
 * 反過來的話，對一條相似度線按「確認」會得到
 * 「這個狀態變更不被允許」—— 而那句話是錯的，
 * 那個動作對一條待查證的邊完全合法，不合法的是**那條邊**。
 */
export async function transitionEdge(
  dataRoot: string,
  slug: string,
  edgeId: string,
  action: EdgeAction,
): Promise<Result<EdgeDetail>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    const edge = edges.getEdge(db, edgeId);
    if (edge === null) return err('GRAPH_EDGE_NOT_FOUND', cid, { edgeId });

    if (!mayAdjudicate({ layer: edge.layer, origin: edge.origin })) {
      return err('GRAPH_LAYER_NOT_ADJUDICABLE', cid, { layer: edge.layer, origin: edge.origin });
    }

    const evidenceCount = edges.evidenceRows(db, edgeId).length;
    const outcome = transition({ from: edge.status, action, origin: edge.origin, evidenceCount });
    if (outcome.kind === 'invalid-transition') {
      return err('GRAPH_TRANSITION_INVALID', cid, { from: edge.status, action });
    }
    if (outcome.kind === 'evidence-required') {
      return err('GRAPH_EVIDENCE_REQUIRED', cid, { edgeId });
    }

    const now = Date.now();
    withTransaction(db, () => {
      edges.setStatus(db, edgeId, outcome.to, now);
      edges.appendAudit(db, {
        edgeId,
        from: edge.status,
        to: outcome.to,
        action,
        actor: 'human',
        at: now,
      });
    });

    const updated = edges.getEdge(db, edgeId);
    if (updated === null) return err('GRAPH_UNEXPECTED', cid, { why: 'edge-vanished' });
    return ok(detailOf(db, updated), cid);
  });
}

// ── 裁決佇列 ────────────────────────────────────────────────

export interface QueueEntry {
  readonly id: string;
  readonly rel: string;
  readonly source: string;
  readonly sourceTitle: string;
  readonly target: string;
  readonly targetTitle: string;
  readonly tier: ConfidenceTier;
  readonly previouslyRejected: boolean;
}

export interface QueuePayload {
  readonly total: number;
  readonly entries: readonly QueueEntry[];
}

/**
 * **佇列不帶校準比例，而那是刻意的。**
 *
 * 校準比例是**分段的**（ADR-0017：段 ＝ `rel` × 可信度等級），
 * 所以它只在「某一條邊」的脈絡下有意義。
 * 掛一個全域數字在佇列上，正是那一份「考慮過但沒選的」裡
 * 明確否決的東西：「全域平均對每一條關聯給同一個數字，等於沒有資訊」。
 */

/**
 * 還在等人判斷的。**只有 `layer='named'`**（ADR-0015）——
 * 另外三層是算出來的結果，沒有人在等你對它們做判斷。
 */
export async function listQueue(dataRoot: string, slug: string): Promise<Result<QueuePayload>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    const rows = edges.pendingQueue(db, QUEUE_LIMIT);
    const titles = titlesOf(
      db,
      rows.flatMap((r) => [r.sourceId, r.targetId]),
    );

    return ok(
      {
        total: edges.pendingCount(db),
        entries: rows.map((row) => ({
          id: row.id,
          rel: row.rel,
          source: row.sourceId,
          sourceTitle: titles.get(row.sourceId) ?? row.sourceId,
          target: row.targetId,
          targetTitle: titles.get(row.targetId) ?? row.targetId,
          tier: tierOf(row.confidence),
          previouslyRejected: row.previouslyRejected,
        })),
      },
      cid,
    );
  });
}

// ── 機器提出（Stage 9 的擴展會呼叫這一支）────────────────────

export interface ProposalSummary {
  readonly created: number;
  readonly merged: number;
  readonly revived: number;
  readonly blocked: number;
  readonly results: readonly edges.ProposalResult[];
}

/**
 * 機器提出一批邊。
 *
 * **沒有 HTTP 端點** —— 這條路只有擴展作業走得到（Stage 9），
 * 而擴展是從 `POST …/runs` 進來的。開一個「請幫我寫一條機器邊」的端點
 * 等於給了一條繞過墓碑與出處要求的路。
 *
 * 整批包在一個交易裡：**墓碑檢查是「先讀後寫」**，
 * 而那個形狀在沒有交易的情況下有一個空隙（`withTransaction` 的註解）。
 */
export async function proposeEdges(
  dataRoot: string,
  slug: string,
  proposals: readonly edges.Proposal[],
): Promise<Result<ProposalSummary>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    const now = Date.now();

    const results = withTransaction(db, () => {
      const out: edges.ProposalResult[] = [];
      for (const proposal of proposals) {
        // 兩端都得存在。**機器提出一條連到不存在節點的邊是它自己的 bug**，
        // 而讓外鍵在整批的中間炸掉會把其他每一條也一起回滾
        if (graph.nodeKindOf(db, proposal.source) === null) continue;
        if (graph.nodeKindOf(db, proposal.target) === null) continue;
        if (proposal.source === proposal.target) continue;
        out.push(edges.applyProposal(db, proposal, now));
      }
      return out;
    });

    return ok(
      {
        created: results.filter((r) => r.kind === 'created').length,
        merged: results.filter((r) => r.kind === 'merged').length,
        revived: results.filter((r) => r.kind === 'revived').length,
        blocked: results.filter((r) => r.kind === 'blocked-by-tombstone').length,
        results,
      },
      cid,
    );
  });
}
