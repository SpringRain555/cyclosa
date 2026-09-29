/**
 * 研究的讀寫（schema v9／v10）。
 *
 * **四張表各管一件事**：`research` 是工作流停在哪、`research_message` 是規劃對話的每一輪、
 * `research_direction` 是閘門一那一刻落成的方向表（v10 起記得搜過了沒有）、
 * `research_candidate` 是蒐集找到的每一個來源（v10）。
 *
 * 規則（可不可以再談一輪、閘門一按不按得下去）**不在這裡** ——
 * 那是 `domain/research` 的純函式。這一層只負責把它們變成資料列。
 */
import type { DatabaseSync } from 'node:sqlite';

import {
  isRelevance,
  sumTaskCosts,
  type Bibliography,
  type Relevance,
  type TaskCosts,
} from '../../../domain/provider/index.js';
import {
  acquisitionOf,
  expectedAccessOf,
  unavailableReasonOf,
  type Acquisition,
  type ExpectedAccess,
  type ResearchKind,
  type ResearchStatus,
  type UnavailableReason,
} from '../../../domain/research/index.js';

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
  /** 搜過了沒有（v10）。**搜過、找到 0 份的是 `done`**，搜失敗的是 `failed`（可以重來）*/
  readonly searchState: 'pending' | 'done' | 'failed';
  readonly searchCode: string | null;
  readonly searchedAt: number | null;
}

export interface ResearchCandidateRow {
  readonly id: string;
  readonly researchId: string;
  /** 第一條找到它的方向 */
  readonly directionId: string | null;
  /** 之後也找到它的方向（**同一個網址只有一列**）*/
  readonly alsoDirections: readonly string[];
  readonly ord: number;
  readonly url: string;
  readonly title: string;
  readonly why: string;
  readonly bib: Bibliography;
  readonly expectedAccess: ExpectedAccess;
  readonly acquisition: Acquisition;
  /** 抓不到的那一種（擷取的錯誤碼）。**`needs-user` 而 `code` 是 null ＝ 依你的紀錄沒去試** */
  readonly code: string | null;
  readonly unavailableReason: UnavailableReason | null;
  readonly reasonNote: string;
  readonly itemId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * 初讀的判斷（schema v11，Stage 21）：跟**這一次研究**有沒有關（同一份資料對別的主題可能無關，
   * 所以住在候選上、不在 item 上）。`null` 而 `digestCode` 也是 `null` ＝ 還沒讀。
   */
  readonly relevance: Relevance | null;
  readonly relevanceWhy: string;
  /** 初讀失敗的原因。**有碼 ＝ 讀過但失敗** —— 「繼續蒐集」會再讀一次 */
  readonly digestCode: string | null;
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
    searchState: stateOf(row['search_state']),
    searchCode: str(row['search_code']),
    searchedAt: num(row['searched_at']),
  };
}

function stateOf(value: unknown): 'pending' | 'done' | 'failed' {
  return value === 'done' || value === 'failed' ? value : 'pending';
}

function jsonOf(raw: unknown, fallback: unknown): unknown {
  try {
    const parsed: unknown = JSON.parse(String(raw ?? ''));
    return parsed ?? fallback;
  } catch {
    // **這幾欄是說明，不是規則** —— 壞掉的一欄不該讓整次研究打不開（同 `keywords_json`）。
    return fallback;
  }
}

function toCandidate(row: Raw): ResearchCandidateRow {
  const also = jsonOf(row['also_directions_json'], []);
  const rawBib = jsonOf(row['bib_json'], {});
  const bib = (typeof rawBib === 'object' && rawBib !== null ? rawBib : {}) as Raw;
  const field = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    id: String(row['id']),
    researchId: String(row['research_id']),
    directionId: str(row['direction_id']),
    alsoDirections: Array.isArray(also) ? also.map((d) => String(d)) : [],
    ord: Number(row['ord'] ?? 0),
    url: String(row['url'] ?? ''),
    title: String(row['title'] ?? ''),
    why: String(row['why'] ?? ''),
    bib: { authors: field(bib['authors']), year: field(bib['year']), venue: field(bib['venue']) },
    expectedAccess: expectedAccessOf(row['expected_access']),
    acquisition: acquisitionOf(row['acquisition']),
    code: str(row['code']),
    unavailableReason: unavailableReasonOf(row['unavailable_reason']),
    reasonNote: String(row['reason_note'] ?? ''),
    itemId: str(row['item_id']),
    createdAt: Number(row['created_at']),
    updatedAt: Number(row['updated_at']),
    relevance: isRelevance(row['relevance']) ? row['relevance'] : null,
    relevanceWhy: String(row['relevance_why'] ?? ''),
    digestCode: str(row['digest_code']),
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
 * **只有還停在 `from` 的時候才換**，回傳換了沒有。
 *
 * 蒐集那一筆作業在背景跑，而它跑完的那一刻，使用者可能已經在另一個請求裡按了「放棄」——
 * 不帶條件的寫入會把「放棄了」蓋回「等你」。這一支讓後到的那一個輸。
 */
export function moveResearchIf(
  db: DatabaseSync,
  id: string,
  from: ResearchStatus,
  to: ResearchStatus,
  now: number,
): boolean {
  const final = to === 'done' || to === 'abandoned';
  const result = db
    .prepare(
      'UPDATE research SET status = ?, updated_at = ?, ended_at = ? WHERE id = ? AND status = ?',
    )
    .run(to, now, final ? now : null, id, from);
  return Number(result.changes) === 1;
}

/** 這次研究現在（最新）的那一筆蒐集作業。 */
export function setCollectRun(db: DatabaseSync, id: string, runId: string, now: number): void {
  db.prepare('UPDATE research SET collect_run_id = ?, updated_at = ? WHERE id = ?').run(
    runId,
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

/**
 * 刪一次研究（`research_message`、`research_direction`、`research_candidate` 跟著 CASCADE 走）。
 *
 * **作業不刪**：`run.research_id` 是 `SET NULL` —— 它們是「圖上這些東西來自哪裡」的唯一紀錄
 * （ADR-0033 D15）。
 */
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
): { readonly costUsd: number; readonly unknown: number; readonly byTask: TaskCosts } {
  const talk = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total,
              SUM(CASE WHEN role = 'model' AND cost_usd IS NULL THEN 1 ELSE 0 END) AS unknown,
              SUM(CASE WHEN role = 'model' THEN 1 ELSE 0 END) AS turns,
              SUM(CASE WHEN role = 'model' AND cost_usd IS NOT NULL THEN 1 ELSE 0 END) AS priced
         FROM research_message WHERE research_id = ?`,
    )
    .get(researchId) as Raw | undefined;
  // **作業那一半**（v10）：蒐集的每一筆，「繼續蒐集」開出來的也算。
  // `unpriced` 是那一筆裡沒回報花費的次數 —— 加總只加得到回報過的那幾次。
  const work = db
    .prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total, COALESCE(SUM(unpriced), 0) AS unknown
         FROM run WHERE research_id = ?`,
    )
    .get(researchId) as Raw | undefined;

  // **逐任務的那一份**（v11，R29）。v11 以前的蒐集作業沒有拆 —— 那時候它只做一件事（找來源），
  // 所以它的總數整份算在找來源底下；不這樣的話，拆開的那幾格加起來會比總數少。
  const runs = db
    .prepare(
      `SELECT kind, requests, cost_usd, unpriced, task_costs_json FROM run WHERE research_id = ?`,
    )
    .all(researchId) as Raw[];
  const perRun: unknown[] = runs.map((r) => {
    const json = str(r['task_costs_json']);
    if (json !== null) {
      try {
        return JSON.parse(json) as unknown;
      } catch {
        return null;
      }
    }
    if (r['kind'] !== 'research') return null;
    return {
      'find-sources': {
        requests: Number(r['requests'] ?? 0),
        costUsd: num(r['cost_usd']),
        unpriced: Number(r['unpriced'] ?? 0),
      },
    };
  });
  const turns = Number(talk?.['turns'] ?? 0);
  if (turns > 0) {
    perRun.push({
      plan: {
        requests: turns,
        costUsd: Number(talk?.['priced'] ?? 0) > 0 ? Number(talk?.['total'] ?? 0) : null,
        unpriced: Number(talk?.['unknown'] ?? 0),
      },
    });
  }

  return {
    costUsd: Number(talk?.['total'] ?? 0) + Number(work?.['total'] ?? 0),
    unknown: Number(talk?.['unknown'] ?? 0) + Number(work?.['unknown'] ?? 0),
    byTask: sumTaskCosts(perRun),
  };
}

/** 這次研究的每一筆作業（新的在前）。刪研究時要連它們的模型呼叫紀錄一起刪（D15）。 */
export function listResearchRunIds(db: DatabaseSync, researchId: string): readonly string[] {
  const rows = db
    .prepare('SELECT id FROM run WHERE research_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(researchId) as Raw[];
  return rows.map((r) => String(r['id']));
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

/** 一條方向搜完了（或搜失敗了）。 */
export function markDirectionSearched(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly state: 'done' | 'failed';
    readonly code: string | null;
    readonly now: number;
  },
): void {
  db.prepare(
    'UPDATE research_direction SET search_state = ?, search_code = ?, searched_at = ? WHERE id = ?',
  ).run(input.state, input.code, input.now, input.id);
}

// ── 候選（v10）────────────────────────────────────────────

export function listCandidates(
  db: DatabaseSync,
  researchId: string,
): readonly ResearchCandidateRow[] {
  const rows = db
    .prepare('SELECT * FROM research_candidate WHERE research_id = ? ORDER BY ord')
    .all(researchId) as Raw[];
  return rows.map(toCandidate);
}

export function getCandidate(db: DatabaseSync, id: string): ResearchCandidateRow | null {
  const row = db.prepare('SELECT * FROM research_candidate WHERE id = ?').get(id) as
    Raw | undefined;
  return row === undefined ? null : toCandidate(row);
}

/**
 * 寫一個找到的候選。**同一次研究裡同一個網址只有一列**（資料表的 UNIQUE）：
 * 已經有了的話，把這條方向記進 `also_directions_json`，回傳 `false`（不是新的）。
 */
export function addCandidate(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly researchId: string;
    readonly directionId: string;
    readonly url: string;
    readonly title: string;
    readonly why: string;
    readonly bib: Bibliography;
    readonly expectedAccess: ExpectedAccess;
    readonly acquisition: Exclude<Acquisition, 'unavailable'>;
    readonly now: number;
  },
): boolean {
  const existing = db
    .prepare('SELECT * FROM research_candidate WHERE research_id = ? AND url = ?')
    .get(input.researchId, input.url) as Raw | undefined;
  if (existing !== undefined) {
    const row = toCandidate(existing);
    if (row.directionId !== input.directionId && !row.alsoDirections.includes(input.directionId)) {
      db.prepare(
        'UPDATE research_candidate SET also_directions_json = ?, updated_at = ? WHERE id = ?',
      ).run(JSON.stringify([...row.alsoDirections, input.directionId]), input.now, row.id);
    }
    return false;
  }
  const top = db
    .prepare('SELECT MAX(ord) AS top FROM research_candidate WHERE research_id = ?')
    .get(input.researchId) as Raw | undefined;
  const ord = num(top?.['top']);
  db.prepare(
    `INSERT INTO research_candidate
       (id, research_id, direction_id, ord, url, title, why, bib_json, expected_access, acquisition,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.researchId,
    input.directionId,
    ord === null ? 0 : ord + 1,
    input.url,
    input.title,
    input.why,
    JSON.stringify(input.bib),
    input.expectedAccess,
    input.acquisition,
    input.now,
    input.now,
  );
  return true;
}

/**
 * 換一個候選的取得狀態。**`unavailable` 不走這一支**（它要帶原因，見 `markUnavailable`）——
 * 資料表的 CHECK 守著「拿不到一定帶原因、原因只跟拿不到一起出現」，這一支一律把原因清掉。
 */
export function setAcquisition(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly acquisition: Exclude<Acquisition, 'unavailable'>;
    readonly code: string | null;
    /** `undefined` ＝ 不動 `item_id` */
    readonly itemId?: string | null;
    readonly now: number;
  },
): void {
  if (input.itemId === undefined) {
    db.prepare(
      `UPDATE research_candidate
          SET acquisition = ?, code = ?, unavailable_reason = NULL, reason_note = '', updated_at = ?
        WHERE id = ?`,
    ).run(input.acquisition, input.code, input.now, input.id);
    return;
  }
  db.prepare(
    `UPDATE research_candidate
        SET acquisition = ?, code = ?, item_id = ?, unavailable_reason = NULL, reason_note = '',
            updated_at = ?
      WHERE id = ?`,
  ).run(input.acquisition, input.code, input.itemId, input.now, input.id);
}

/** 你說拿不到，而且說了原因（R11）。**抓過的錯誤碼留著** —— 那是「你為什麼這樣判斷」的一半。 */
export function markUnavailable(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly reason: UnavailableReason;
    readonly note: string;
    readonly now: number;
  },
): void {
  db.prepare(
    `UPDATE research_candidate
        SET acquisition = 'unavailable', unavailable_reason = ?, reason_note = ?, updated_at = ?
      WHERE id = ?`,
  ).run(input.reason, input.note, input.now, input.id);
}

/**
 * 一份候選的初讀結果（schema v11，Stage 21）。**判斷寫在候選上，繁中寫在 item 上**
 * （`item-repo.ts` 的 `setItemDigest`）—— 前者是「跟這一次研究有沒有關」，後者是那一份資料本身的衍生物。
 *
 * `relevance` 是 `null` 而 `code` 有值 ＝ 讀過但失敗（「繼續蒐集」會再讀）；兩個都有值不會發生
 * （成功的那一次把碼清掉）。
 */
export function setCandidateDigest(
  db: DatabaseSync,
  input: {
    readonly id: string;
    readonly relevance: Relevance | null;
    readonly why: string;
    readonly code: string | null;
    readonly now: number;
  },
): void {
  db.prepare(
    `UPDATE research_candidate SET relevance = ?, relevance_why = ?, digest_code = ?, updated_at = ?
      WHERE id = ?`,
  ).run(
    input.relevance,
    input.why,
    input.relevance === null ? input.code : null,
    input.now,
    input.id,
  );
}

/**
 * 停在半路的那幾列（`fetching`）放回「還沒抓」。
 *
 * 程式在抓的時候停了（關掉、當掉），那一列會一直寫著「抓取中」—— 而沒有任何作業在抓它。
 * 蒐集作業開始與結束時各呼叫一次。
 */
export function resetFetching(db: DatabaseSync, researchId: string, now: number): number {
  const result = db
    .prepare(
      `UPDATE research_candidate SET acquisition = 'found', updated_at = ?
        WHERE research_id = ? AND acquisition = 'fetching'`,
    )
    .run(now, researchId);
  return Number(result.changes);
}

/**
 * 這一份資料是哪一次研究的候選（閱讀器那一行「候選 · 研究『…』還沒確認」，ADR-0033 D8）。
 *
 * **只回還沒結束的那一次**：確認過（Stage 22）或放棄了的研究，它就只是一份資料。
 */
export function openCandidacyOf(
  db: DatabaseSync,
  itemId: string,
): { readonly researchId: string; readonly topic: string } | null {
  const row = db
    .prepare(
      `SELECT r.id AS id, r.topic AS topic
         FROM research_candidate c JOIN research r ON r.id = c.research_id
        WHERE c.item_id = ? AND r.open_key = 1
        LIMIT 1`,
    )
    .get(itemId) as Raw | undefined;
  if (row === undefined) return null;
  return { researchId: String(row['id']), topic: String(row['topic'] ?? '') };
}
