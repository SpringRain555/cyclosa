/**
 * 研究的讀寫（schema v9）。
 *
 * **三張表各管一件事**：`research` 是工作流停在哪、`research_message` 是規劃對話的每一輪、
 * `research_direction` 是閘門一那一刻落成的方向表。
 *
 * 規則（可不可以再談一輪、閘門一按不按得下去）**不在這裡** ——
 * 那是 `domain/research` 的純函式。這一層只負責把它們變成資料列。
 */
import type { DatabaseSync } from 'node:sqlite';

import type { ResearchKind, ResearchStatus } from '../../../domain/research/index.js';

export interface ResearchRow {
  readonly id: string;
  readonly kind: ResearchKind;
  readonly status: ResearchStatus;
  /** 整理沒有主題 */
  readonly topic: string | null;
  /** 最新的一份規劃（JSON 字串，原樣進出 —— 解析在上一層）*/
  readonly planJson: string;
  /** 輸入主題當下的全文檢索命中（JSON 字串）*/
  readonly hitsJson: string;
  readonly collectRunId: string | null;
  readonly buildRunId: string | null;
  readonly correlationId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly endedAt: number | null;
}

export interface ResearchMessageRow {
  readonly id: string;
  readonly researchId: string;
  readonly ord: number;
  readonly role: 'user' | 'model';
  readonly content: string;
  readonly planJson: string | null;
  readonly model: string | null;
  readonly via: string | null;
  /** **`null` ＝ 不知道**，不是 0 */
  readonly costUsd: number | null;
  readonly elapsedMs: number | null;
  readonly code: string | null;
  readonly at: number;
}

export interface ResearchDirectionRow {
  readonly id: string;
  readonly researchId: string;
  readonly ord: number;
  readonly title: string;
  readonly what: string;
  readonly expect: string;
  readonly keywords: readonly string[];
  readonly origin: 'model' | 'human';
  readonly adopted: boolean;
}

type Raw = Record<string, unknown>;
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toResearch(row: Raw): ResearchRow {
  return {
    id: String(row['id']),
    kind: String(row['kind']) as ResearchKind,
    status: String(row['status']) as ResearchStatus,
    topic: str(row['topic']),
    planJson: String(row['plan_json'] ?? '{}'),
    hitsJson: String(row['hits_json'] ?? '[]'),
    collectRunId: str(row['collect_run_id']),
    buildRunId: str(row['build_run_id']),
    correlationId: String(row['correlation_id'] ?? ''),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    endedAt: num(row['ended_at']),
  };
}

function toMessage(row: Raw): ResearchMessageRow {
  return {
    id: String(row['id']),
    researchId: String(row['research_id']),
    ord: Number(row['ord'] ?? 0),
    role: String(row['role']) === 'model' ? 'model' : 'user',
    content: String(row['content'] ?? ''),
    planJson: str(row['plan_json']),
    model: str(row['model']),
    via: str(row['via']),
    costUsd: num(row['cost_usd']),
    elapsedMs: num(row['elapsed_ms']),
    code: str(row['code']),
    at: Number(row['at']),
  };
}

function toDirection(row: Raw): ResearchDirectionRow {
  let keywords: string[] = [];
  try {
    const parsed: unknown = JSON.parse(String(row['keywords_json'] ?? '[]'));
    if (Array.isArray(parsed)) keywords = parsed.map((k) => String(k));
  } catch {
    // 壞掉的 JSON 就當成沒有關鍵詞。**這一欄是給模型的提示，不是規則** ——
    // 為了它讓整次研究打不開，代價不成比例（同 `run_angle.seeds_json`）。
  }
  return {
    id: String(row['id']),
    researchId: String(row['research_id']),
    ord: Number(row['ord'] ?? 0),
    title: String(row['title'] ?? ''),
    what: String(row['what'] ?? ''),
    expect: String(row['expect'] ?? ''),
    keywords,
    origin: String(row['origin']) === 'human' ? 'human' : 'model',
    adopted: Number(row['adopted'] ?? 1) === 1,
  };
}

/**
 * 開一次研究。
 *
 * **同一個專題同時只有一次沒結束的**（ADR-0033 D4）是資料庫的部分唯一索引在守，
 * 所以這一支違反時會丟例外 —— 呼叫端要接住它並回一個說得出原因的錯誤碼。
 */
export function insertResearch(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly kind: ResearchKind;
    readonly topic: string | null;
    readonly hitsJson: string;
    readonly correlationId: string;
    readonly now: number;
  },
): void {
  db.prepare(
    `INSERT INTO research (id, kind, status, topic, plan_json, hits_json, correlation_id, created_at, updated_at)
     VALUES (?, ?, 'planning', ?, '{}', ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.kind,
    input.topic,
    input.hitsJson,
    input.correlationId,
    input.now,
    input.now,
  );
}

export function getResearch(db: DatabaseSync, id: string): ResearchRow | null {
  const row = db.prepare('SELECT * FROM research WHERE id = ?').get(id) as Raw | undefined;
  return row === undefined ? null : toResearch(row);
}

/** 這個專題還沒結束的那一次。**最多一列**（資料庫守著）。 */
export function openResearch(db: DatabaseSync): ResearchRow | null {
  const row = db.prepare('SELECT * FROM research WHERE open_key = 1').get() as Raw | undefined;
  return row === undefined ? null : toResearch(row);
}

/**
 * 歷次紀錄，新的在前。
 *
 * **`rowid` 是斷同分的那一把** —— 同一毫秒開的兩次研究（測試裡就是這樣，
 * 而畫面上連按兩次也會）光看 `created_at` 排不出先後，而一個順序不穩的清單
 * 會在每次重新整理時換一種排法。`rowid` 是寫入順序，跟時間同方向。
 */
export function listResearch(db: DatabaseSync, limit: number): readonly ResearchRow[] {
  const rows = db
    .prepare('SELECT * FROM research ORDER BY created_at DESC, rowid DESC LIMIT ?')
    .all(limit) as Raw[];
  return rows.map(toResearch);
}

/** 換掉最新的那一份規劃（閘門一之前每談一輪、每改一次方向都會換）。 */
export function updateResearchPlan(
  db: DatabaseSync,
  id: string,
  planJson: string,
  now: number,
): void {
  db.prepare('UPDATE research SET plan_json = ?, updated_at = ? WHERE id = ?').run(
    planJson,
    now,
    id,
  );
}

/**
 * 換狀態。**終態同時寫 `ended_at`** —— 兩者分開寫的話，
 * 會出現一筆「已完成但沒有結束時間」的研究，而那種列讀得到卻說不出它什麼時候結束。
 */
export function updateResearchStatus(
  db: DatabaseSync,
  id: string,
  status: ResearchStatus,
  now: number,
): void {
  const final = status === 'done' || status === 'abandoned';
  db.prepare('UPDATE research SET status = ?, updated_at = ?, ended_at = ? WHERE id = ?').run(
    status,
    now,
    final ? now : null,
    id,
  );
}

/** 刪一次研究（`research_message` 與 `research_direction` 跟著 CASCADE 走）。 */
export function deleteResearch(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare('DELETE FROM research WHERE id = ?').run(id).changes) === 1;
}

// ── 對話 ──────────────────────────────────────────────────

export function insertMessage(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly researchId: string;
    readonly ord: number;
    readonly role: 'user' | 'model';
    readonly content: string;
    readonly planJson?: string | null;
    readonly model?: string | null;
    readonly via?: string | null;
    readonly costUsd?: number | null;
    readonly elapsedMs?: number | null;
    readonly code?: string | null;
    readonly now: number;
  },
): void {
  db.prepare(
    `INSERT INTO research_message
       (id, research_id, ord, role, content, plan_json, model, via, cost_usd, elapsed_ms, code, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.researchId,
    input.ord,
    input.role,
    input.content,
    input.planJson ?? null,
    input.model ?? null,
    input.via ?? null,
    input.costUsd ?? null,
    input.elapsedMs ?? null,
    input.code ?? null,
    input.now,
  );
}

export function listMessages(db: DatabaseSync, researchId: string): readonly ResearchMessageRow[] {
  const rows = db
    .prepare('SELECT * FROM research_message WHERE research_id = ? ORDER BY ord')
    .all(researchId) as Raw[];
  return rows.map(toMessage);
}

/** 下一輪的序號。**空的時候是 0** —— 序號是顯示順序，不是筆數。 */
export function nextOrd(db: DatabaseSync, researchId: string): number {
  const row = db
    .prepare('SELECT MAX(ord) AS top FROM research_message WHERE research_id = ?')
    .get(researchId) as Raw | undefined;
  const top = num(row?.['top']);
  return top === null ? 0 : top + 1;
}

/**
 * 到目前為止這次研究花了多少。
 *
 * **回兩個數字**：加總，以及「有幾輪沒回報」。合成一個數字的話，
 * 一次全部都沒回報的研究會顯示成「花了 $0.00」——
 * 而那對線上端點是一句謊（`run.cost_usd` 的同一條規則）。
 */
export function costSoFar(
  db: DatabaseSync,
  researchId: string,
): { readonly costUsd: number; readonly unknown: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total,
              SUM(CASE WHEN role = 'model' AND cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown
         FROM research_message WHERE research_id = ?`,
    )
    .get(researchId) as Raw | undefined;
  return { costUsd: Number(row?.['total'] ?? 0), unknown: Number(row?.['unknown'] ?? 0) };
}

// ── 方向 ──────────────────────────────────────────────────

export function insertDirection(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly researchId: string;
    readonly ord: number;
    readonly title: string;
    readonly what: string;
    readonly expect: string;
    readonly keywords: readonly string[];
    readonly origin: 'model' | 'human';
    readonly adopted: boolean;
    readonly now: number;
  },
): void {
  db.prepare(
    `INSERT INTO research_direction
       (id, research_id, ord, title, what, expect, keywords_json, origin, adopted, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.researchId,
    input.ord,
    input.title,
    input.what,
    input.expect,
    JSON.stringify(input.keywords),
    input.origin,
    input.adopted ? 1 : 0,
    input.now,
  );
}

export function listDirections(
  db: DatabaseSync,
  researchId: string,
): readonly ResearchDirectionRow[] {
  const rows = db
    .prepare('SELECT * FROM research_direction WHERE research_id = ? ORDER BY ord')
    .all(researchId) as Raw[];
  return rows.map(toDirection);
}
