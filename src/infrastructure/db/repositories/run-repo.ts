/**
 * 作業與作業項目的讀寫。
 *
 * **`run_item` 才是作業紀錄那一頁的資料來源**，不是 `item` ——
 * 一個輸入不一定會變成一個 `item`（robots 不准、404、已經有了），
 * 而那一頁必須看得到它們。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { RunEndedReason, RunKind, RunStatus } from '../../../domain/ingest/state.js';
import type { TaskCosts } from '../../../domain/provider/budget.js';
import type { RunEdgeFact, RunItemFact } from '../../../domain/run/index.js';

export type RunItemOutcome =
  'queued' | 'running' | 'ok' | 'duplicate' | 'failed' | 'skipped' | 'cancelled';

export type { RunEndedReason, RunKind };

export interface RunRow {
  readonly id: string;
  readonly kind: RunKind;
  readonly status: RunStatus;
  readonly label: string;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly errorCode: string | null;
  /**
   * 怎麼結束的（schema v8）。**只有取消才有值，而且不是每一次取消都有。**
   *
   * `null` ＝ 使用者自己按的取消（或這一列根本不是取消）、
   * `'shutdown'` ＝ 關閉程式時一起取消的、
   * `'stale'` ＝ 掃描標的：上一次結束時它還沒跑完（**分不出**是關閉時沒趕上，
   * 還是被強制結束）。
   */
  readonly endedReason: RunEndedReason | null;
  readonly correlationId: string;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly createdAt: number;
  // ── 擴展才有的（schema v4）──────────────────────────────
  /** 匯入沒有主題，所以是 `null` —— **兩種 run 共用一張表** */
  readonly topic: string | null;
  /** `{"chat":"…","agent":"…"}`。換了模型重跑結果會不一樣，所以要留 */
  readonly providers: string | null;
  readonly requests: number;
  /** **`null` 與 0 是兩件事**：本機模型真的是 0，沒回報的是不知道 */
  readonly costUsd: number | null;
  // ── 研究才有的（schema v10）──────────────────────────────
  /** 這一筆作業屬於哪一次研究。**研究被刪掉之後是 `null`**，作業本身留著（ADR-0033 D15） */
  readonly researchId: string | null;
  /**
   * 有幾次呼叫**沒回報花費**。`costUsd` 只加總回報過的那幾次，
   * 所以光看它分不出「全部都回報了」與「一半沒回報」。
   */
  readonly unpriced: number;
}

export interface RunItemRow {
  readonly id: string;
  readonly runId: string;
  readonly requested: string;
  readonly host: string | null;
  readonly itemId: string | null;
  readonly outcome: RunItemOutcome;
  readonly code: string | null;
  readonly newNodes: number;
  readonly newEdges: number;
  readonly waitedMs: number | null;
  readonly at: number | null;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toRun(row: Raw): RunRow {
  return {
    id: String(row['id']),
    kind: String(row['kind']) as RunKind,
    status: String(row['status']) as RunStatus,
    label: String(row['label'] ?? ''),
    total: Number(row['total'] ?? 0),
    succeeded: Number(row['succeeded'] ?? 0),
    failed: Number(row['failed'] ?? 0),
    errorCode: str(row['error_code']),
    endedReason: str(row['ended_reason']) as RunEndedReason | null,
    correlationId: String(row['correlation_id'] ?? ''),
    startedAt: num(row['started_at']),
    endedAt: num(row['ended_at']),
    createdAt: Number(row['created_at']),
    topic: str(row['topic']),
    providers: str(row['providers_json']),
    requests: Number(row['requests'] ?? 0),
    costUsd: num(row['cost_usd']),
    researchId: str(row['research_id']),
    unpriced: Number(row['unpriced'] ?? 0),
  };
}

function toRunItem(row: Raw): RunItemRow {
  return {
    id: String(row['id']),
    runId: String(row['run_id']),
    requested: String(row['requested']),
    host: str(row['host']),
    itemId: str(row['item_id']),
    outcome: String(row['outcome']) as RunItemOutcome,
    code: str(row['code']),
    newNodes: Number(row['new_nodes'] ?? 0),
    newEdges: Number(row['new_edges'] ?? 0),
    waitedMs: num(row['waited_ms']),
    at: num(row['at']),
  };
}

export function insertRun(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly kind: RunKind;
    readonly label: string;
    readonly total: number;
    readonly correlationId: string;
    readonly now: number;
    readonly topic?: string | null;
    readonly providers?: string | null;
    /** 研究的作業才有（schema v10）。 */
    readonly researchId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO run (id, kind, status, label, total, correlation_id, created_at, topic, providers_json, research_id)
     VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.kind,
    input.label,
    input.total,
    input.correlationId,
    input.now,
    input.topic ?? null,
    input.providers ?? null,
    input.researchId ?? null,
  );
}

/**
 * 記這一次作業總共打了幾次模型、花了多少。
 *
 * **`costUsd` 是 `null` 就不要寫 0 進去** —— 那一欄存在的全部理由
 * 就是把「本機執行，金額成本真的是 0」跟「這個 provider 沒回報」分開。
 */
export function updateRunBudget(
  db: DatabaseSync,
  id: string,
  requests: number,
  costUsd: number | null,
  /** 沒回報花費的次數（schema v10）。**跟 `costUsd` 一起寫**，分開寫會有一刻對不起來。 */
  unpriced: number,
  /**
   * 逐任務的那一份（schema v11，`task_costs_json`）。**同一句 UPDATE 寫** —— 總數與拆開的那一份
   * 分兩次寫的話，中間那一刻畫面會讀到加不起來的兩個數字。不給就不動那一欄（舊的擴展不拆）。
   */
  taskCosts?: TaskCosts,
): void {
  if (taskCosts === undefined) {
    db.prepare('UPDATE run SET requests = ?, cost_usd = ?, unpriced = ? WHERE id = ?').run(
      requests,
      costUsd,
      unpriced,
      id,
    );
    return;
  }
  db.prepare(
    'UPDATE run SET requests = ?, cost_usd = ?, unpriced = ?, task_costs_json = ? WHERE id = ?',
  ).run(requests, costUsd, unpriced, JSON.stringify(taskCosts), id);
}

/** 總項目數在擴展裡是「勾了幾條角度」，而那要等使用者勾完才知道。 */
/**
 * 補寫這次作業用了哪些 provider。
 *
 * 擴展分兩階段，而**抽取那一個模型的格式保證要到第二階段才確定**
 * （沒量過的話，第二階段開始前才量）。第一階段寫下的那一份
 * 在那時候還說不出來，所以這裡整份換掉，不是合併 —— 呼叫端持有完整的那一份。
 */
export function updateRunProviders(db: DatabaseSync, id: string, providers: string): void {
  db.prepare('UPDATE run SET providers_json = ? WHERE id = ?').run(providers, id);
}

export function updateRunTotal(db: DatabaseSync, id: string, total: number): void {
  db.prepare('UPDATE run SET total = ? WHERE id = ?').run(total, id);
}

export function startRun(db: DatabaseSync, id: string, now: number): void {
  db.prepare("UPDATE run SET status = 'running', started_at = ? WHERE id = ?").run(now, id);
}

export function settleRunRow(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly status: RunStatus;
    readonly succeeded: number;
    readonly failed: number;
    readonly errorCode?: string | null;
    /** 幾乎都是不給 —— 只有關閉程式與啟動掃孤兒那兩條路會帶（schema v8）。 */
    readonly endedReason?: RunEndedReason | null;
    readonly now: number;
  },
): void {
  db.prepare(
    `UPDATE run SET status = ?, succeeded = ?, failed = ?, error_code = ?, ended_reason = ?, ended_at = ?
     WHERE id = ?`,
  ).run(
    input.status,
    input.succeeded,
    input.failed,
    input.errorCode ?? null,
    input.endedReason ?? null,
    input.now,
    input.id,
  );
}

export function getRun(db: DatabaseSync, id: string): RunRow | null {
  const row = db.prepare('SELECT * FROM run WHERE id = ?').get(id) as Raw | undefined;
  return row === undefined ? null : toRun(row);
}

export function listRuns(db: DatabaseSync, limit: number): readonly RunRow[] {
  const rows = db.prepare('SELECT * FROM run ORDER BY created_at DESC LIMIT ?').all(limit) as Raw[];
  return rows.map(toRun);
}

export function insertRunItem(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly runId: string;
    readonly requested: string;
    readonly host: string | null;
  },
): void {
  db.prepare(
    "INSERT INTO run_item (id, run_id, requested, host, outcome) VALUES (?, ?, ?, ?, 'queued')",
  ).run(input.id, input.runId, input.requested, input.host);
}

export function updateRunItem(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly outcome: RunItemOutcome;
    readonly code?: string | null;
    readonly itemId?: string | null;
    readonly newNodes?: number;
    readonly waitedMs?: number | null;
    readonly now: number;
  },
): void {
  db.prepare(
    `UPDATE run_item SET outcome = ?, code = ?, item_id = ?, new_nodes = ?, waited_ms = ?, at = ?
     WHERE id = ?`,
  ).run(
    input.outcome,
    input.code ?? null,
    input.itemId ?? null,
    input.newNodes ?? 0,
    input.waitedMs ?? null,
    input.now,
    input.id,
  );
}

export function listRunItems(db: DatabaseSync, runId: string): readonly RunItemRow[] {
  const rows = db
    .prepare('SELECT * FROM run_item WHERE run_id = ? ORDER BY id')
    .all(runId) as Raw[];
  return rows.map(toRunItem);
}

/** 還沒被處理的項目 —— 取消之後要把它們標成 `已取消`，**不是失敗**。 */
export function cancelPendingItems(db: DatabaseSync, runId: string, now: number): number {
  const result = db
    .prepare(
      `UPDATE run_item SET outcome = 'cancelled', at = ?
       WHERE run_id = ? AND outcome IN ('queued','running')`,
    )
    .run(now, runId);
  return Number(result.changes);
}

/**
 * 標著「執行中」的作業。
 *
 * **只有 `running`，`queued` 不算。** 這一條不是保守，是正確：
 * 擴展的 `排隊` 的意思是**「在等你勾」**（`POST /runs` 產生切入角度之後
 * 就停在這裡），而那個狀態**撐得過重新啟動** —— `chooseAngles` 只看
 * 資料庫裡的 `status === 'queued'`，不問記憶體裡有沒有這個 run。
 * 把它掃掉等於把一個使用者還沒回答的問題丟掉。
 *
 * 呼叫端仍然要濾掉本行程正在跑的那些（`isActive`），
 * 因為掃描在專題**第一次被打開**時才跑，而那時候可能已經有作業在跑了。
 */
export function listRunningRunIds(db: DatabaseSync): readonly string[] {
  const rows = db
    .prepare("SELECT id FROM run WHERE status = 'running' ORDER BY created_at")
    .all() as Raw[];
  return rows.map((r) => String(r['id']));
}

/**
 * 把一列沒收尾的作業標成已取消，並記下**為什麼**。
 *
 * 不動 `succeeded`／`failed` —— 那兩個數字是它跑到一半時真的完成的量，
 * 而 `settleRunRow` 會覆寫它們。
 */
export function markRunEnded(
  db: DatabaseSync,
  input: { readonly id: string; readonly reason: RunEndedReason; readonly now: number },
): void {
  db.prepare(
    "UPDATE run SET status = 'cancelled', ended_reason = ?, ended_at = ? WHERE id = ?",
  ).run(input.reason, input.now, input.id);
}

// ── 切入角度（schema v4）────────────────────────────────────

export interface RunAngleRow {
  readonly id: string;
  readonly runId: string;
  readonly ord: number;
  readonly question: string;
  readonly stance: string;
  /** 這條角度是從專題裡既有的哪幾份長出來的（`item.id`）*/
  readonly seeds: readonly string[];
  readonly selected: boolean;
  readonly foundUrls: number;
  readonly newNodes: number;
  readonly newEdges: number;
  readonly code: string | null;
}

function toAngle(row: Raw): RunAngleRow {
  let seeds: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row['seeds_json'] ?? '[]'));
    if (Array.isArray(parsed)) seeds = parsed.map((s) => String(s));
  } catch {
    // 壞掉的 JSON 就當成沒有種子。**這一欄是說明，不是規則** ——
    // 為了它讓整張作業紀錄打不開，代價不成比例。
  }
  return {
    id: String(row['id']),
    runId: String(row['run_id']),
    ord: Number(row['ord'] ?? 0),
    question: String(row['question'] ?? ''),
    stance: String(row['stance'] ?? ''),
    seeds,
    selected: Number(row['selected'] ?? 0) === 1,
    foundUrls: Number(row['found_urls'] ?? 0),
    newNodes: Number(row['new_nodes'] ?? 0),
    newEdges: Number(row['new_edges'] ?? 0),
    code: str(row['code']),
  };
}

export function insertAngle(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly runId: string;
    readonly ord: number;
    readonly question: string;
    readonly stance: string;
    readonly seeds: readonly string[];
    readonly now: number;
  },
): void {
  db.prepare(
    `INSERT INTO run_angle (id, run_id, ord, question, stance, seeds_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.runId,
    input.ord,
    input.question,
    input.stance,
    JSON.stringify(input.seeds),
    input.now,
  );
}

export function listAngles(db: DatabaseSync, runId: string): readonly RunAngleRow[] {
  const rows = db
    .prepare('SELECT * FROM run_angle WHERE run_id = ? ORDER BY ord')
    .all(runId) as Raw[];
  return rows.map(toAngle);
}

/**
 * 勾選。**沒被勾的那幾條留著而且留成「沒被勾」** ——
 * 「工具提了六條、你只要兩條」是這次作業發生過的事實的一部分。
 */
export function selectAngles(db: DatabaseSync, runId: string, ids: readonly string[]): number {
  db.prepare('UPDATE run_angle SET selected = 0 WHERE run_id = ?').run(runId);
  if (ids.length === 0) return 0;
  const stmt = db.prepare('UPDATE run_angle SET selected = 1 WHERE run_id = ? AND id = ?');
  let changed = 0;
  for (const id of ids) changed += Number(stmt.run(runId, id).changes);
  return changed;
}

export function finishAngle(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly foundUrls: number;
    readonly newNodes: number;
    readonly newEdges: number;
    readonly code: string | null;
  },
): void {
  db.prepare(
    'UPDATE run_angle SET found_urls = ?, new_nodes = ?, new_edges = ?, code = ? WHERE id = ?',
  ).run(input.foundUrls, input.newNodes, input.newEdges, input.code, input.id);
}

/** 一條作業項目寫進去幾條邊。匯入那一條路永遠是 0，所以它沒有這一支。 */
export function setRunItemEdges(db: DatabaseSync, id: string, newEdges: number): void {
  db.prepare('UPDATE run_item SET new_edges = ? WHERE id = ?').run(newEdges, id);
}

// ── 復原這次作業 ──────────────────────────────────────────
//
// **這一區只讀出「這次作業寫了什麼」與「人動過哪些」**，
// 要刪哪些是 `domain/run/undo.ts` 的規則，不在這裡。

/** 這次作業寫進去的關聯，連同判斷「人動過沒有」需要的兩個事實。 */
export function runEdgeFacts(db: DatabaseSync, runId: string): readonly RunEdgeFact[] {
  const rows = db
    .prepare(
      `SELECT e.id AS id, e.origin AS origin,
              EXISTS (SELECT 1 FROM edge_audit a
                       WHERE a.edge_id = e.id AND a.actor = 'human') AS judged
         FROM edge e WHERE e.run_id = ?`,
    )
    .all(runId) as Raw[];

  const evidence = db.prepare('SELECT item_id FROM edge_evidence WHERE edge_id = ?');
  return rows.map((row) => {
    const id = String(row['id']);
    const items = (evidence.all(id) as Raw[]).map((e) => String(e['item_id']));
    return {
      id,
      origin: String(row['origin']) === 'human' ? ('human' as const) : ('machine' as const),
      adjudicatedByHuman: Number(row['judged']) === 1,
      evidenceItemIds: items,
    };
  });
}

/** 這次作業寫進去的資料，連同三種「你對它表過態」。 */
export function runItemFacts(db: DatabaseSync, runId: string): readonly RunItemFact[] {
  const rows = db
    .prepare(
      `SELECT i.id AS id, i.read_at AS read_at, i.status AS status,
              EXISTS (SELECT 1 FROM note n WHERE n.item_id = i.id) AS annotated
         FROM item i WHERE i.run_id = ?`,
    )
    .all(runId) as Raw[];
  return rows.map((row) => ({
    id: String(row['id']),
    read: row['read_at'] !== null && row['read_at'] !== undefined,
    annotated: Number(row['annotated']) === 1,
    excluded: String(row['status']) === 'excluded',
  }));
}

/**
 * 刪除。**一次一批，包在呼叫端的交易裡。**
 *
 * `edge_evidence` 與 `edge_audit` 有 `ON DELETE CASCADE`，所以刪邊就夠了。
 */
export function deleteEdgesById(db: DatabaseSync, ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const stmt = db.prepare('DELETE FROM edge WHERE id = ?');
  for (const id of ids) stmt.run(id);
  return ids.length;
}

export function deleteItemsById(db: DatabaseSync, ids: readonly string[]): number {
  if (ids.length === 0) return 0;
  const stmt = db.prepare('DELETE FROM item WHERE id = ?');
  for (const id of ids) stmt.run(id);
  return ids.length;
}

/**
 * 刪完之後一條邊都沒有的實體。
 *
 * **一個零度數的實體在「焦點 ＋ 幾跳」的圖上等於不存在**（同 ADR-0008 的理由），
 * 而它只有擴展會建立、而且擴展一定會同時建共同提及的邊 ——
 * 所以「零度數」就是「這次被刪掉的邊留下來的殘骸」。
 *
 * **被合併過的不算**：`merged_into` 指著別人的那些本來就沒有自己的邊。
 */
export function deleteOrphanEntities(db: DatabaseSync): number {
  const rows = db
    .prepare(
      `SELECT id FROM entity
        WHERE merged_into IS NULL
          AND NOT EXISTS (SELECT 1 FROM edge WHERE source_id = entity.id OR target_id = entity.id)`,
    )
    .all() as Raw[];
  const stmt = db.prepare('DELETE FROM entity WHERE id = ?');
  for (const row of rows) stmt.run(String(row['id']));
  return rows.length;
}

/**
 * 丟掉一筆**還沒開始**的擴展草稿。
 *
 * 呼叫端要先確認 `status === 'queued'`：那種 run 只有 `run_angle`（跟著 CASCADE 走），
 * `total` 是 0、沒有 `run_item`、沒有任何 item 或 edge 指著它 —— 所以刪它就是刪一列。
 * 跑過的 run 不走這裡：它寫進去的東西要留（「復原」是另一顆按鈕，ADR-0023）。
 */
export function deleteDraftRun(db: DatabaseSync, id: string): boolean {
  const result = db.prepare(`DELETE FROM run WHERE id = ? AND status = 'queued'`).run(id);
  return Number(result.changes) === 1;
}
