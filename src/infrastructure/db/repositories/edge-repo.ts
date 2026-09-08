/**
 * 單條邊的讀寫、裁決與稽核 —— **Stage 8 的寫入路徑。**
 *
 * `graph-repo.ts` 讀的是「一屏」，這一份讀寫的是「一條」。
 *
 * ## 三個順序上的坑，全部由 schema 逼出來
 *
 * 1. **機器建的邊不能直接 INSERT 成 `confirmed`。**
 *    `trg_edge_confirm_requires_evidence_ins` 對「機器 ＋ 已確認」的 INSERT
 *    **無條件擋下** —— 不是「檢查有沒有出處」，是根本擋掉，
 *    因為出處有 `edge_id` 外鍵，在邊還不存在的時候寫不進去。
 *    所以順序只有一種：**先 `pending` → 寫出處 → 再 UPDATE 成 `confirmed`。**
 *
 * 2. **人建的邊可以直接是 `confirmed`**（trigger 的條件是 `origin='machine'`），
 *    而且**必須**是 —— api-contract：「一建立就是已確認 ＋ `origin='human'`」。
 *
 * 3. **機器建的非 `named` 邊只能是 `pending`**（migration 003，Q6 的答案）。
 *
 * ## `edge_audit` 記什麼、不記什麼
 *
 * **只記「狀態被改變」，不記「邊被建立」。**
 * 建立這件事 `edge` 自己就記著了（`created_at`、`origin`、`run_id`），
 * 而 20 萬條機器邊各寫一列建立紀錄，會讓稽核表比它要稽核的東西還大。
 */
import type { DatabaseSync } from 'node:sqlite';

import type {
  ConfidenceTier,
  EdgeAction,
  EdgeLayer,
  EdgeOrigin,
  EdgeRef,
  EdgeStatus,
} from '../../../domain/graph/index.js';
import {
  countIndependentSources,
  evaluateProposal,
  machineMayUpdateStatus,
  scoreFor,
  tierRange,
} from '../../../domain/graph/index.js';
import { newId } from '../../../shared/id.js';
import { derivedGroups, toEdge, type EdgeRow } from './graph-repo.js';

type Raw = Record<string, unknown>;

// ── 型別 ────────────────────────────────────────────────────

export interface EvidenceRow {
  readonly id: string;
  readonly edgeId: string;
  readonly itemId: string;
  /** 出處出自哪一份的標題。**面板要顯示它，而使用者不認得 id** */
  readonly itemTitle: string;
  readonly quote: string;
  readonly charStart: number;
  readonly charEnd: number;
  readonly createdAt: number;
}

export interface AuditRow {
  readonly id: string;
  readonly edgeId: string;
  readonly fromStatus: string;
  readonly toStatus: string;
  readonly action: string;
  readonly actor: 'human' | 'machine';
  readonly runId: string | null;
  readonly at: number;
}

/** 建立一條邊要給的東西。**`status` 不在這裡** —— 它由 `origin` 與 `layer` 決定。 */
export interface NewEdge extends EdgeRef {
  readonly layer: EdgeLayer;
  readonly sourceKind: 'item' | 'entity';
  readonly targetKind: 'item' | 'entity';
  readonly origin: EdgeOrigin;
  readonly confidence: number;
  readonly runId?: string | null;
}

export interface NewEvidence {
  readonly itemId: string;
  readonly quote: string;
  readonly charStart: number;
  readonly charEnd: number;
}

// ── 讀 ──────────────────────────────────────────────────────

export function getEdge(db: DatabaseSync, id: string): EdgeRow | null {
  const row = db.prepare('SELECT * FROM edge WHERE id = ?').get(id) as Raw | undefined;
  return row === undefined ? null : toEdge(row);
}

/**
 * 依三元組找邊。**墓碑查詢與重複檢查用的是同一支** ——
 * 因為它們問的是同一件事：「這個（來源, 目標, 關係型別）已經有一列了嗎」。
 *
 * 方向有意義（`tombstoneKey` 那一條）：A→B 不等於 B→A。
 */
export function findByTriple(db: DatabaseSync, ref: EdgeRef): EdgeRow | null {
  const row = db
    .prepare('SELECT * FROM edge WHERE source_id = ? AND target_id = ? AND rel = ? LIMIT 1')
    .get(ref.source, ref.target, ref.rel) as Raw | undefined;
  return row === undefined ? null : toEdge(row);
}

/** 一條邊的全部出處，含它出自哪一份的標題。 */
export function evidenceRows(db: DatabaseSync, edgeId: string): readonly EvidenceRow[] {
  const rows = db
    .prepare(
      `SELECT e.*, COALESCE(i.title, '') AS item_title
         FROM edge_evidence e LEFT JOIN item i ON i.id = e.item_id
        WHERE e.edge_id = ? ORDER BY e.created_at, e.id`,
    )
    .all(edgeId) as Raw[];
  return rows.map((row) => ({
    id: String(row['id']),
    edgeId: String(row['edge_id']),
    itemId: String(row['item_id']),
    itemTitle: String(row['item_title'] ?? ''),
    quote: String(row['quote'] ?? ''),
    charStart: Number(row['char_start'] ?? 0),
    charEnd: Number(row['char_end'] ?? 0),
    createdAt: Number(row['created_at']),
  }));
}

/** 一條邊的裁決歷史，**新的在前**。 */
export function auditOf(db: DatabaseSync, edgeId: string): readonly AuditRow[] {
  const rows = db
    .prepare('SELECT * FROM edge_audit WHERE edge_id = ? ORDER BY at DESC, id DESC')
    .all(edgeId) as Raw[];
  return rows.map((row) => ({
    id: String(row['id']),
    edgeId: String(row['edge_id']),
    fromStatus: String(row['from_status']),
    toStatus: String(row['to_status']),
    action: String(row['action']),
    actor: String(row['actor']) as 'human' | 'machine',
    runId: row['run_id'] === null ? null : String(row['run_id']),
    at: Number(row['at']),
  }));
}

/** 這條邊被人裁決過嗎 —— **`machineMayUpdateStatus` 的第二個參數**。 */
export function everAdjudicated(db: DatabaseSync, edgeId: string): boolean {
  const row = db
    .prepare("SELECT 1 AS x FROM edge_audit WHERE edge_id = ? AND actor = 'human' LIMIT 1")
    .get(edgeId) as Raw | undefined;
  return row !== undefined;
}

/**
 * 校準比例的樣本：**每條邊的最新一次人工判定，一條邊一票**（ADR-0016）。
 *
 * ## 它是分段的，不是全域的
 *
 * ADR-0017 訂的「段」＝ **`edge.rel` × 可信度等級**，而且那一份的
 * 「考慮過但沒選的」**明確否決了全域平均**：
 * 「全域平均對每一條關聯給同一個數字，等於沒有資訊」。
 *
 * 所以這一支要傳一個 `segment` 進來。等級在 SQL 裡是**分數區間比較**，
 * 不是字串比較 —— 等級是顯示用的，存的一直是連續分數。
 *
 * ## 另外兩個範圍限制，兩個都不是隨手加的
 *
 * **只採計 `actor='human'`**：墓碑例外會讓機器寫一列 `rejected → pending`
 * 的紀錄（見 `applyProposal`），那不是使用者的判斷。
 *
 * **只採計 `origin='machine'` 的邊**：校準比例回答的是
 * 「**你對機器提出來的東西判得準不準**」。人自己手動建的邊一建立就是已確認，
 * 把它們算進去等於在分子分母上各加一筆必然的「確認」——
 * 手動建得越多，比例就越接近 100%，而那個數字不代表任何事情。
 */
export function latestHumanVerdicts(
  db: DatabaseSync,
  segment: { readonly rel: string; readonly tier: ConfidenceTier },
): readonly ('confirmed' | 'rejected')[] {
  const [floor, ceiling] = tierRange(segment.tier);
  const rows = db
    .prepare(
      `SELECT a.to_status AS verdict FROM edge_audit a
         JOIN edge e ON e.id = a.edge_id
        WHERE a.actor = 'human' AND e.origin = 'machine'
          AND e.rel = ? AND e.confidence >= ? AND e.confidence < ?
          AND a.to_status IN ('confirmed','rejected')
          AND a.at = (
            SELECT MAX(b.at) FROM edge_audit b
             WHERE b.edge_id = a.edge_id AND b.actor = 'human'
               AND b.to_status IN ('confirmed','rejected')
          )
        GROUP BY a.edge_id`,
    )
    .all(segment.rel, floor, ceiling) as Raw[];
  return rows.map((row) => String(row['verdict']) as 'confirmed' | 'rejected');
}

/**
 * 裁決佇列 —— **只有 `layer='named'` 的待查證邊**（api-contract）。
 *
 * 排序是可信度由高到低：**先看機器最有把握的那些**，
 * 因為在那一段判錯的代價最高（它們會被當成已知事實用下去）。
 */
export function pendingQueue(db: DatabaseSync, limit: number): readonly EdgeRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM edge WHERE layer = 'named' AND status = 'pending'
        ORDER BY confidence DESC, created_at ASC, id ASC LIMIT ?`,
    )
    .all(limit) as Raw[];
  return rows.map(toEdge);
}

export function pendingCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM edge WHERE layer = 'named' AND status = 'pending'")
    .get() as Raw | undefined;
  return Number(row?.['n'] ?? 0);
}

// ── 寫 ──────────────────────────────────────────────────────

export function insertEvidence(
  db: DatabaseSync,
  edgeId: string,
  rows: readonly NewEvidence[],
  now: number,
): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO edge_evidence (id, edge_id, item_id, quote, char_start, char_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    stmt.run(newId(), edgeId, row.itemId, row.quote, row.charStart, row.charEnd, now);
  }
}

export function appendAudit(
  db: DatabaseSync,
  entry: {
    readonly edgeId: string;
    readonly from: EdgeStatus;
    readonly to: EdgeStatus;
    readonly action: EdgeAction;
    readonly actor: 'human' | 'machine';
    readonly runId?: string | null;
    readonly at: number;
  },
): void {
  db.prepare(
    `INSERT INTO edge_audit (id, edge_id, from_status, to_status, action, actor, run_id, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    entry.edgeId,
    entry.from,
    entry.to,
    entry.action,
    entry.actor,
    entry.runId ?? null,
    entry.at,
  );
}

/**
 * 建立一條邊。**回傳它的 id。**
 *
 * `status` 是算出來的不是傳進來的：**人建的一律 `confirmed`，機器建的一律 `pending`。**
 * 讓呼叫端傳 `status` 的話，遲早會有一個呼叫端傳
 * 「機器 ＋ confirmed」進來，然後在 trigger 上炸掉 —— 而那個錯誤訊息
 * 會出現在離原因很遠的地方。
 *
 * 要一條「機器 ＋ 已確認」的邊，唯一的路是建立之後補出處再 `confirm`。
 */
export function insertEdge(
  db: DatabaseSync,
  edge: NewEdge,
  now: number,
  previouslyRejected = false,
): string {
  const id = newId();
  const status: EdgeStatus = edge.origin === 'human' ? 'confirmed' : 'pending';
  db.prepare(
    `INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind,
                       origin, status, confidence, previously_rejected, run_id,
                       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    edge.layer,
    edge.rel,
    edge.source,
    edge.sourceKind,
    edge.target,
    edge.targetKind,
    edge.origin,
    status,
    edge.confidence,
    previouslyRejected ? 1 : 0,
    edge.runId ?? null,
    now,
    now,
  );
  return id;
}

/** 只改狀態。**`updated_at` 一起改** —— 兩個分開寫遲早會有一次忘記。 */
export function setStatus(db: DatabaseSync, edgeId: string, status: EdgeStatus, now: number): void {
  db.prepare('UPDATE edge SET status = ?, updated_at = ? WHERE id = ?').run(status, now, edgeId);
}

export function setConfidence(db: DatabaseSync, edgeId: string, value: number, now: number): void {
  db.prepare('UPDATE edge SET confidence = ?, updated_at = ? WHERE id = ?').run(value, now, edgeId);
}

function markPreviouslyRejected(db: DatabaseSync, edgeId: string, now: number): void {
  db.prepare('UPDATE edge SET previously_rejected = 1, updated_at = ? WHERE id = ?').run(
    now,
    edgeId,
  );
}

// ── 機器提出一條邊 ──────────────────────────────────────────

export interface Proposal extends EdgeRef {
  readonly layer: EdgeLayer;
  readonly sourceKind: 'item' | 'entity';
  readonly targetKind: 'item' | 'entity';
  readonly confidence: number;
  readonly evidence: readonly NewEvidence[];
  readonly runId?: string | null;
}

export type ProposalResult =
  /** 新的一條，進待查證 */
  | { readonly kind: 'created'; readonly edgeId: string }
  /** 已經有這一條了，只附加了出處（狀態沒動） */
  | { readonly kind: 'merged'; readonly edgeId: string; readonly addedEvidence: number }
  /** 墓碑例外：帶著新出處復活，標「曾被否決」 */
  | { readonly kind: 'revived'; readonly edgeId: string }
  /** 有墓碑而且沒有新出處 —— **什麼都沒寫** */
  | { readonly kind: 'blocked-by-tombstone'; readonly edgeId: string };

/**
 * 機器提出一條邊。**Stage 9 的擴展寫入路徑會呼叫這一支。**
 *
 * ## 兩支守門函式必須照這個順序問，而它們看起來都像是全部的答案
 *
 * `machineMayUpdateStatus`（狀態機規則 1）說：**被人碰過的邊，狀態不准動。**
 * 一條已否決的邊當然被人碰過 —— 照它問，墓碑例外就永遠不會發生。
 *
 * `evaluateProposal`（ADR-0016）說：**帶著新出處的話，已否決的邊要復活。**
 * 照它問，一條被人確認過的邊也會被機器動到 —— 而那是規則 1 要擋的那件事。
 *
 * **兩支都不是全部的答案，它們管的是不相交的兩條路：**
 *
 * | 既有那一列的狀態 | 走哪一支 | 為什麼 |
 * |---|---|---|
 * | `rejected` | `evaluateProposal` | 這是墓碑，而墓碑有明文例外（ADR-0016） |
 * | 其他 | `machineMayUpdateStatus` | 這是重跑，而重跑只附加出處 |
 *
 * 先問錯那一支，症狀是**安靜的**：不是報錯，是墓碑例外從此不觸發
 * （或者反過來，是使用者確認過的邊被機器改掉）。
 */
export function applyProposal(db: DatabaseSync, proposal: Proposal, now: number): ProposalResult {
  const ref: EdgeRef = { source: proposal.source, target: proposal.target, rel: proposal.rel };
  const existing = findByTriple(db, ref);

  if (existing === null) {
    const id = insertEdge(
      db,
      {
        ...ref,
        layer: proposal.layer,
        sourceKind: proposal.sourceKind,
        targetKind: proposal.targetKind,
        origin: 'machine',
        confidence: proposal.confidence,
        runId: proposal.runId ?? null,
      },
      now,
    );
    insertEvidence(db, id, proposal.evidence, now);
    // **分數的規則只寫在一個地方。** 第一次寫入時它跟提案帶來的值一樣，
    // 但把它也走一次，重跑那一條路才不會是唯一算得對的路。
    recomputeConfidence(db, id, proposal.layer, now);
    return { kind: 'created', edgeId: id };
  }

  const existingItems = evidenceRows(db, existing.id).map((e) => e.itemId);
  const incomingItems = proposal.evidence.map((e) => e.itemId);

  // ── 墓碑那一條路 ────────────────────────────────────────
  if (existing.status === 'rejected') {
    const outcome = evaluateProposal({
      ref,
      hasTombstone: true,
      existingEvidenceItemIds: existingItems,
      incomingEvidenceItemIds: incomingItems,
    });

    if (outcome.kind === 'blocked-by-tombstone') {
      // **什麼都不寫。** 連出處都不附加 —— 依定義這批出處沒有一筆
      // 來自新的 `item`，所以寫進去不會讓任何人知道任何新的事，
      // 只會讓下一次的「新出處」判斷變得更難成立。
      return { kind: 'blocked-by-tombstone', edgeId: existing.id };
    }

    const fresh = proposal.evidence.filter((e) => !existingItems.includes(e.itemId));
    insertEvidence(db, existing.id, fresh, now);
    setStatus(db, existing.id, 'pending', now);
    markPreviouslyRejected(db, existing.id, now);
    appendAudit(db, {
      edgeId: existing.id,
      from: 'rejected',
      to: 'pending',
      action: 'restore',
      // **這是稽核紀錄裡唯一一種 `machine`。**
      // `edge_audit.actor` 允許 machine 就是為了這一條 ——
      // 使用者要看得出「這條邊為什麼從否決區跑回佇列」。
      actor: 'machine',
      runId: proposal.runId ?? null,
      at: now,
    });
    recomputeConfidence(db, existing.id, proposal.layer, now);
    return { kind: 'revived', edgeId: existing.id };
  }

  // ── 重跑那一條路 ────────────────────────────────────────
  const fresh = proposal.evidence.filter((e) => !existingItems.includes(e.itemId));
  insertEvidence(db, existing.id, fresh, now);

  // 沒有人判斷過的待查證邊可以更新可信度（沒有東西被覆寫）
  if (machineMayUpdateStatus(existing.status, everAdjudicated(db, existing.id))) {
    recomputeConfidence(db, existing.id, proposal.layer, now);
  }
  return { kind: 'merged', edgeId: existing.id, addedEvidence: fresh.length };
}

/**
 * 依**這條邊現在真的有的出處**重算可信度。
 *
 * ## 為什麼不能直接用提案帶來的那個數字
 *
 * 每一次提案都是「一份文件、一句引文」，所以提案帶來的分數永遠是
 * 「1 個獨立來源 ＋ 有引文」那個值 —— **它每次都一樣**。
 * 拿它跟既有值比大小的話，第二個來源、第三個來源全部不會讓分數動，
 * 而「獨立來源越多越可信」正是 `scoreFor` 唯一在說的事。
 *
 * 症狀會是安靜的：面板上「出處 3 筆 · 3 個獨立來源」與「可信度：弱」
 * 同時出現，而沒有任何地方看得出那兩行是矛盾的。
 *
 * ## 只算 `named`
 *
 * 其餘三層的分數不是從出處來的（`comention` 是骨架、`derived` 是機器可驗、
 * `similarity` 是相似度本身），**照這一支重算會把它們全部歸零。**
 */
export function recomputeConfidence(
  db: DatabaseSync,
  edgeId: string,
  layer: EdgeLayer,
  now: number,
): void {
  if (layer !== 'named') return;
  const rows = evidenceRows(db, edgeId);
  const score = scoreFor({
    independentSourceCount: countIndependentSources(
      rows,
      derivedGroups(
        db,
        rows.map((r) => r.itemId),
      ),
    ),
    hasDirectQuote: rows.some((r) => r.quote.trim().length > 0),
  });
  setConfidence(db, edgeId, score, now);
}
