/**
 * 「研究」的用例編排 —— **這一版只做到閘門一**（Stage 19，ADR-0033、REQ-0009 R1–R6）。
 *
 * ```
 * POST /research                → 開一次研究（**一次模型呼叫都沒有**，只跑全文檢索）
 *          ↓  談一輪、改方向、再談一輪…
 * POST /research/:id/start      → 閘門一：方向落成一張表
 *          ↓  蒐集（Stage 20）、確認（Stage 22）
 * ```
 *
 * ## 這一支存在的全部理由是「花錢之前停下來」
 *
 * 舊的擴展按下去就開始搜尋、抓取、抽取，使用者看不到模型打算怎麼找（2026-09-18 的第 12 點）。
 * 所以這裡每一步都要說得出「現在花了什麼」：
 *
 * | 步驟 | 花錢嗎 |
 * |---|---|
 * | 開一次研究（相關性命中）| **不花** —— 全文檢索用的是本機索引 |
 * | 談一輪 | 花：規劃對話那個服務 |
 * | 改方向、刪方向 | **不花** —— 那是人自己改的 |
 * | 閘門一 | 按下去**這一支就結束了**；真的去找是下一個 Stage |
 *
 * ## 方向表在閘門一才落成
 *
 * 規劃期間的方向住在 `research.plan_json`（人改過的標 `human`）。閘門一按下去的那一刻，
 * 它落成 `research_direction` 一條一列 —— 之後的蒐集、統計、確認都對著那張表（D5）。
 * **模型提過、使用者刪掉的也一起落成**（`adopted = 0`）：模型提了哪些、你留了哪些，
 * 是這次研究的一部分（跟 `run_angle` 保留沒被勾的角度同一個理由）。
 */
import { join } from 'node:path';

import type { ErrorCode } from '../domain/errors/codes.js';
import {
  missingFor,
  normalizeDirection,
  normalizePlan,
  TASK_PLAN,
  type CapabilityFlag,
  type DirectionDraft,
  type PlanDraft,
} from '../domain/provider/index.js';
import {
  kindOf,
  mayAbandon,
  mayConverse,
  mayDelete,
  mayEditDirections,
  mayStartCollecting,
  type ResearchKind,
  type ResearchStatus,
} from '../domain/research/index.js';
import { openCaseDatabase, type DatabaseSync } from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as research from '../infrastructure/db/repositories/research-repo.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { appendModelCall } from '../infrastructure/fs/model-log.js';
import { endpointOf } from '../domain/provider/call-record.js';
import { loadProviders, type Providers } from '../infrastructure/providers/registry.js';
import type { ConnectionKind } from '../infrastructure/providers/config.js';
import { correlationId, newId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';
import {
  MAX_HIT_EXCERPT_CHARS,
  PLAN_SCHEMA,
  PLAN_SYSTEM,
  planUser,
  type PlanHit,
  type PlanTurn,
} from './research-prompts.js';
import { searchCase } from './search-service.js';

const CASE_DB_FILE = 'case.sqlite';

/** 相關性命中最多顯示幾份。**這一步不花錢，但畫面要放得下**（R1）。 */
export const MAX_HITS = 5;

/** 一輪規劃對話等多久。CLI 那一條會邊查邊談，所以比一般對話久。 */
export const PLAN_TIMEOUT_MS = 180_000;

export type ProvidersLoader = () => Promise<Providers>;

async function openCase(dataRoot: string, slug: string): Promise<DatabaseSync | ErrorCode> {
  const opened = await openCaseDatabase(join(casesDir(dataRoot), slug, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new') return 'CASE_SCHEMA_TOO_NEW';
  if (opened.kind === 'migrate-failed') return 'CASE_SCHEMA_MIGRATE_FAILED';
  if (opened.kind === 'missing') return 'CASE_NOT_FOUND';
  return opened.db;
}

// ── 對外的形狀 ──────────────────────────────────────────────

export interface ResearchHit {
  readonly itemId: string;
  readonly title: string;
  readonly excerpt: string;
}

export interface DirectionView extends DirectionDraft {
  /** 誰提的。**使用者改過的那一條就是人提的**（R4：畫面上標「你改的」）。 */
  readonly origin: 'model' | 'human';
}

export interface PlanView {
  readonly relation: string;
  readonly directions: readonly DirectionView[];
  readonly outOfScope: readonly string[];
  /** 模型上一輪提的超過上限。**畫面照實說**，不靜默截掉（R6）。 */
  readonly overflow: boolean;
}

export interface MessageView {
  readonly id: string;
  readonly role: 'user' | 'model';
  readonly content: string;
  readonly model: string | null;
  readonly via: string | null;
  readonly costUsd: number | null;
  readonly elapsedMs: number | null;
  readonly code: string | null;
  readonly at: number;
}

/** 閘門一之後那張表（`adopted = 0` 的是模型提過、使用者刪掉的）。 */
export interface FrozenDirection extends DirectionView {
  readonly id: string;
  readonly adopted: boolean;
}

/** 規劃對話走哪個服務、會不會上網查。**閘門旁邊那句「會花錢嗎」要用它**（R5）。 */
export interface PlanService {
  readonly via: ConnectionKind;
  readonly model: string;
  /** 這條服務會不會上網查。**本機 Ollama 是 false，而那不是壞掉**（D5）。 */
  readonly browses: boolean;
  /** 會不會花錢：本機不會，CLI 與線上端點會。 */
  readonly costs: boolean;
}

export interface ResearchView {
  readonly id: string;
  readonly kind: ResearchKind;
  readonly status: ResearchStatus;
  readonly topic: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 專題裡總共幾份、其中幾份提到這個主題（R1）。 */
  readonly hitTotal: number;
  readonly hits: readonly ResearchHit[];
  readonly plan: PlanView;
  readonly messages: readonly MessageView[];
  readonly directions: readonly FrozenDirection[];
  /** 到目前為止花了多少；`unknownCost` 是「有幾輪沒回報」（R29）。 */
  readonly costUsd: number;
  readonly unknownCost: number;
  readonly service: PlanService;
}

const EMPTY_PLAN_VIEW: PlanView = {
  relation: '',
  directions: [],
  outOfScope: [],
  overflow: false,
};

/** `plan_json` 存的是 `PlanView`。**讀不回來就當空的** —— 壞掉的一欄不該讓整次研究打不開。 */
function planOf(raw: string): PlanView {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_PLAN_VIEW;
    const row = parsed as Record<string, unknown>;
    const directions: DirectionView[] = [];
    for (const entry of Array.isArray(row['directions']) ? row['directions'] : []) {
      const draft = normalizeDirection(entry);
      if (draft === null) continue;
      const origin = (entry as Record<string, unknown>)['origin'] === 'human' ? 'human' : 'model';
      directions.push({ ...draft, origin });
    }
    return {
      relation: typeof row['relation'] === 'string' ? row['relation'] : '',
      directions,
      outOfScope: Array.isArray(row['outOfScope']) ? row['outOfScope'].map((s) => String(s)) : [],
      overflow: row['overflow'] === true,
    };
  } catch {
    return EMPTY_PLAN_VIEW;
  }
}

function hitsOf(raw: string): readonly ResearchHit[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((entry) => {
      const row = (entry ?? {}) as Record<string, unknown>;
      return {
        itemId: String(row['itemId'] ?? ''),
        title: String(row['title'] ?? ''),
        excerpt: String(row['excerpt'] ?? ''),
      };
    });
  } catch {
    return [];
  }
}

function serviceOf(providers: Providers): PlanService {
  const setting = providers.config.tasks.plan;
  return {
    via: setting.via,
    model: setting.model,
    // 本機 Ollama 不會上網查（D5）；另外兩條會 —— OpenAI 那一條「會不會真的搜尋」是量的，
    // 而那個量測顯示在設定頁上，不在這裡重覆一次（這裡回答的是「這條服務有沒有這個能力」）。
    browses: setting.via !== 'ollama',
    costs: setting.via !== 'ollama',
  };
}

function viewOf(db: DatabaseSync, row: research.ResearchRow, providers: Providers): ResearchView {
  const cost = research.costSoFar(db, row.id);
  const hits = hitsOf(row.hitsJson);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    topic: row.topic ?? '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hitTotal: items.countByStatus(db)['included'] ?? 0,
    hits,
    plan: planOf(row.planJson),
    messages: research.listMessages(db, row.id).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      model: m.model,
      via: m.via,
      costUsd: m.costUsd,
      elapsedMs: m.elapsedMs,
      code: m.code,
      at: m.at,
    })),
    directions: research.listDirections(db, row.id).map((d) => ({
      id: d.id,
      title: d.title,
      what: d.what,
      expect: d.expect,
      keywords: d.keywords,
      origin: d.origin,
      adopted: d.adopted,
    })),
    costUsd: cost.costUsd,
    unknownCost: cost.unknown,
    service: serviceOf(providers),
  };
}

function capabilityError(cid: string, flags: readonly CapabilityFlag[]): Result<never> {
  return err('PROVIDER_CAPABILITY_MISSING', cid, { role: 'agent', missing: flags });
}

// ── 開一次研究：一次模型呼叫都沒有 ──────────────────────────

/**
 * 開一次研究。**這一步不花錢**（R1／R5）。
 *
 * 輸入主題的當下跑一次全文檢索，回「你已有的 N 份裡 K 份提到它」。
 * K 是 0 也照說 —— 那本身就是一個資訊（「這是一個新的方向」）。
 *
 * 命中的結果**存下來**（`hits_json`）：它同時是給模型看的素材，
 * 而之後回頭看這次研究時，要知道當時它看到的是什麼。
 */
export async function startResearch(
  dataRoot: string,
  slug: string,
  input: { readonly topic: string; readonly kind?: ResearchKind },
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  const cid = correlationId();
  const kind = kindOf(input.kind);
  const topic = input.topic.trim();
  if (kind === 'research' && topic.length === 0) {
    return err('SEARCH_QUERY_EMPTY', cid, { why: 'no-topic' });
  }

  // 全文檢索自己會開一次資料庫，所以**在我們開之前做完** ——
  // 同一個檔開兩次連線不會壞（WAL），但一個開著卻在等別人的連線沒有意義。
  const found =
    topic.length === 0
      ? null
      : await searchCase(dataRoot, slug, { q: topic, mode: 'text', limit: MAX_HITS });
  const hits: ResearchHit[] =
    found === null || !found.ok
      ? []
      : found.data.hits
          .filter((hit) => hit.kind === 'item')
          .slice(0, MAX_HITS)
          .map((hit) => ({
            itemId: hit.id,
            title: hit.title,
            excerpt: hit.snippet.slice(0, MAX_HIT_EXCERPT_CHARS),
          }));

  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const caseRow = readCase(db);
    if (caseRow === null) return err('CASE_NOT_FOUND', cid, { slug });
    if (caseRow.status === 'archived') return err('CASE_ARCHIVED', cid, { slug });

    /**
     * **同一個專題同時只有一次研究或整理沒結束**（D4）。
     *
     * 這裡先查一次是為了給一個說得出原因的錯誤碼；真正擋住它的是資料庫的部分唯一索引
     * —— 兩個請求同時進來的時候，先查再寫擋不住。
     */
    const open = research.openResearch(db);
    if (open !== null) return err('RESEARCH_ALREADY_OPEN', cid, { researchId: open.id });

    const id = newId();
    const now = Date.now();
    try {
      research.insertResearch(db, {
        id,
        kind,
        topic: kind === 'research' ? topic : null,
        hitsJson: JSON.stringify(hits),
        correlationId: cid,
        now,
      });
    } catch {
      // 索引擋下來了 —— 上面那一查與這一寫之間有人開了一次。
      return err('RESEARCH_ALREADY_OPEN', cid, { slug });
    }
    const row = research.getResearch(db, id);
    if (row === null) return err('RESEARCH_UNEXPECTED', cid, { slug });
    return ok(viewOf(db, row, await load()), cid);
  } finally {
    db.close();
  }
}

// ── 談一輪 ──────────────────────────────────────────────────

/**
 * 談一輪。**這一步會花錢**（走「模型分工」表上規劃對話那個服務）。
 *
 * 使用者的那句話先寫成一列，再帶著整段對話去問模型。**失敗的那一輪也留著**
 * （`code` 有值）—— 模型那一次回了什麼形狀的垃圾，是使用者回報問題時唯一查得到的東西。
 */
export async function converse(
  dataRoot: string,
  slug: string,
  researchId: string,
  said: string,
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  const cid = correlationId();
  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });

  try {
    const row = research.getResearch(db, researchId);
    if (row === null) return err('RESEARCH_NOT_FOUND', cid, { researchId });
    if (!mayConverse(row.status)) {
      return err('RESEARCH_STEP_INVALID', cid, { status: row.status, want: 'converse' });
    }

    const providers = await load();
    const planner = providers.planFor({
      schema: PLAN_SCHEMA,
      systemPrompt: PLAN_SYSTEM,
      maxCostUsd: null,
    });
    if (planner === null) return err('PROVIDER_NOT_CONFIGURED', cid, { role: 'agent' });

    const probe = await planner.probe();
    if (probe.kind === 'not-configured')
      return err('PROVIDER_NOT_CONFIGURED', cid, { role: 'agent' });
    if (probe.kind === 'unreachable') {
      return err('PROVIDER_UNREACHABLE', cid, { role: 'agent', at: probe.detail });
    }
    const match = missingFor(TASK_PLAN, probe.capabilities);
    if (match.kind === 'missing') return capabilityError(cid, match.flags);

    const now = Date.now();
    const text = said.trim();
    if (text.length > 0) {
      research.insertMessage(db, {
        id: newId(),
        researchId,
        ord: research.nextOrd(db, researchId),
        role: 'user',
        content: text,
        now,
      });
    }

    const plan = planOf(row.planJson);
    const turns: PlanTurn[] = research
      .listMessages(db, researchId)
      .filter((m) => m.content.length > 0)
      .map((m) => ({ role: m.role, text: m.content }));
    const hits: PlanHit[] = hitsOf(row.hitsJson).map((h) => ({
      title: h.title,
      excerpt: h.excerpt,
    }));
    const user = planUser({
      topic: row.topic ?? '',
      hits,
      total: items.countByStatus(db)['included'] ?? 0,
      plan: plan.directions.length === 0 ? null : plan,
      turns,
    });

    const call = await planner.run({
      prompt: user,
      cwd: sandboxOf(dataRoot, slug, researchId),
      timeoutMs: PLAN_TIMEOUT_MS,
    });
    const connection = providers.connectionOf('plan');

    if (providers.config.diagnostics.logModelCalls) {
      await appendModelCall(join(casesDir(dataRoot), slug), {
        at: new Date().toISOString(),
        runId: researchId,
        correlationId: cid,
        task: 'plan',
        role: 'agent',
        model: planner.name,
        transport: connection.via === 'cli' ? 'claude-cli' : connection.via,
        endpoint: endpointOf(connection.baseUrl),
        request: { system: PLAN_SYSTEM, user },
        response: {
          text: call.kind === 'ok' ? call.value : null,
          errorDetail: call.kind === 'error' ? call.detail : null,
        },
        outcome: {
          ok: call.kind === 'ok',
          code: call.kind === 'error' ? call.code : null,
          elapsedMs: call.cost.elapsedMs,
          costUsd: call.cost.costUsd,
        },
      });
    }

    const answered = Date.now();
    const common = {
      id: newId(),
      researchId,
      ord: research.nextOrd(db, researchId),
      role: 'model' as const,
      model: planner.name,
      via: connection.via,
      costUsd: call.cost.costUsd,
      elapsedMs: call.cost.elapsedMs,
      now: answered,
    };

    if (call.kind === 'error') {
      research.insertMessage(db, { ...common, content: '', code: call.code });
      const after = research.getResearch(db, researchId);
      return err(call.code, cid, {
        researchId,
        detail: call.detail,
        ...(after === null ? {} : { status: after.status }),
      });
    }

    const draft = parsePlan(call.value);
    if (draft === null) {
      research.insertMessage(db, {
        ...common,
        content: '',
        code: 'PROVIDER_OUTPUT_UNPARSEABLE',
      });
      return err('PROVIDER_OUTPUT_UNPARSEABLE', cid, { researchId });
    }

    const next = mergePlan(plan, draft);
    research.insertMessage(db, {
      ...common,
      content: draft.reply,
      planJson: JSON.stringify(next),
    });
    research.updateResearchPlan(db, researchId, JSON.stringify(next), answered);

    const updated = research.getResearch(db, researchId);
    if (updated === null) return err('RESEARCH_UNEXPECTED', cid, { researchId });
    return ok(viewOf(db, updated, providers), cid);
  } finally {
    db.close();
  }
}

/** `<資料根>\cases\<專題>\agent\research\<id>\`（storage-layout：agent 的沙箱）。 */
function sandboxOf(dataRoot: string, slug: string, researchId: string): string {
  return join(casesDir(dataRoot), slug, 'agent', 'research', researchId);
}

/** agent 交回來的是字串。**解析失敗回 `null`** —— 呼叫端把它記成失敗的一輪。 */
function parsePlan(raw: string): PlanDraft | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const draft = normalizePlan(value);
  // 一個字都沒有的一輪不算一輪：沒有方向、沒有回話、沒有關係說明。
  if (draft.reply.length === 0 && draft.directions.length === 0 && draft.relation.length === 0) {
    return null;
  }
  return draft;
}

/**
 * 模型這一輪的規劃 ＋ 人手改過的東西。
 *
 * **人改過或自己加的方向，模型沒再提就留著。** 使用者手打的那一條在模型眼裡只是
 * 提示詞裡的一行字，它很容易「改寫得更好」或乾脆不提 —— 而那看起來就像
 * 「我剛剛加的東西不見了」。提示詞裡已經寫了不要動它（`PLAN_SYSTEM` 第 7 條），
 * 但**提示詞不是約束**，所以這裡再接一次。
 */
export function mergePlan(current: PlanView, draft: PlanDraft): PlanView {
  const titles = new Set(draft.directions.map((d) => d.title));
  const kept = current.directions.filter((d) => d.origin === 'human' && !titles.has(d.title));
  const fromModel: DirectionView[] = draft.directions.map((d) => {
    // 模型提的這一條，使用者已經改過同名的那一版 —— **以使用者那一版為準**。
    const mine = current.directions.find((c) => c.origin === 'human' && c.title === d.title);
    return mine ?? { ...d, origin: 'model' };
  });
  return {
    relation: draft.relation.length > 0 ? draft.relation : current.relation,
    directions: [...fromModel, ...kept],
    outOfScope: draft.outOfScope,
    overflow: draft.overflow,
  };
}

// ── 改方向：人自己改，不花錢（R4）─────────────────────────

export interface DirectionInput {
  readonly title: string;
  readonly what?: string;
  readonly expect?: string;
  readonly keywords?: readonly string[];
}

/**
 * 整份方向清單換成使用者給的這一份（改、加、刪、重排都是同一件事）。
 *
 * **跟模型那一份逐字一樣的仍然算模型提的** —— 只有真的動過的那幾條標「你改的」。
 * 全部標成人改的話，「你改的」那個標記就沒有意義了。
 */
export async function editDirections(
  dataRoot: string,
  slug: string,
  researchId: string,
  list: readonly DirectionInput[],
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  const cid = correlationId();
  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const row = research.getResearch(db, researchId);
    if (row === null) return err('RESEARCH_NOT_FOUND', cid, { researchId });
    if (!mayEditDirections(row.status)) {
      return err('RESEARCH_STEP_INVALID', cid, { status: row.status, want: 'edit' });
    }
    const current = planOf(row.planJson);
    const directions: DirectionView[] = [];
    const seen = new Set<string>();
    for (const entry of list) {
      const draft = normalizeDirection(entry);
      if (draft === null) continue;
      if (seen.has(draft.title)) continue;
      seen.add(draft.title);
      const before = current.directions.find((d) => d.title === draft.title);
      const same =
        before !== undefined &&
        before.what === draft.what &&
        before.expect === draft.expect &&
        JSON.stringify(before.keywords) === JSON.stringify(draft.keywords);
      directions.push({ ...draft, origin: same ? before.origin : 'human' });
    }
    const next: PlanView = { ...current, directions };
    research.updateResearchPlan(db, researchId, JSON.stringify(next), Date.now());
    const updated = research.getResearch(db, researchId);
    if (updated === null) return err('RESEARCH_UNEXPECTED', cid, { researchId });
    return ok(viewOf(db, updated, await load()), cid);
  } finally {
    db.close();
  }
}

// ── 閘門一 ──────────────────────────────────────────────────

/**
 * 閘門一：**照這份規劃開始**（R5）。
 *
 * 這一支做的事只有一件：把當時的規劃落成方向表，狀態換成「蒐集中」。
 * **真的去找是下一個 Stage** —— 而那正是這個閘門的意思：按下去之前，
 * 一次搜尋、一次擷取都沒有發生過。
 */
export async function startCollecting(
  dataRoot: string,
  slug: string,
  researchId: string,
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  const cid = correlationId();
  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const row = research.getResearch(db, researchId);
    if (row === null) return err('RESEARCH_NOT_FOUND', cid, { researchId });
    const plan = planOf(row.planJson);
    if (!mayStartCollecting(row.status, plan.directions.length)) {
      return err('RESEARCH_STEP_INVALID', cid, {
        status: row.status,
        directions: plan.directions.length,
      });
    }

    const now = Date.now();
    plan.directions.forEach((direction, i) => {
      research.insertDirection(db, {
        id: newId(),
        researchId,
        ord: i,
        title: direction.title,
        what: direction.what,
        expect: direction.expect,
        keywords: direction.keywords,
        origin: direction.origin,
        adopted: true,
        now,
      });
    });

    /**
     * 模型提過、使用者刪掉的那幾條也落成一列（`adopted = 0`）。
     *
     * 來源是對話裡每一輪的規劃 —— **那是唯一記著「它提過什麼」的地方**。
     * 少了這幾列，之後回頭看只看得到留下來的那些，而「你刪掉了什麼」正是
     * 這次研究最值得回頭看的東西之一。
     */
    const kept = new Set(plan.directions.map((d) => d.title));
    let ord = plan.directions.length;
    for (const message of research.listMessages(db, researchId)) {
      if (message.planJson === null) continue;
      for (const direction of planOf(message.planJson).directions) {
        if (kept.has(direction.title)) continue;
        kept.add(direction.title);
        research.insertDirection(db, {
          id: newId(),
          researchId,
          ord,
          title: direction.title,
          what: direction.what,
          expect: direction.expect,
          keywords: direction.keywords,
          origin: direction.origin,
          adopted: false,
          now,
        });
        ord += 1;
      }
    }

    research.updateResearchStatus(db, researchId, 'collecting', now);
    const updated = research.getResearch(db, researchId);
    if (updated === null) return err('RESEARCH_UNEXPECTED', cid, { researchId });
    return ok(viewOf(db, updated, await load()), cid);
  } finally {
    db.close();
  }
}

// ── 放棄與刪除 ──────────────────────────────────────────────

export async function abandonResearch(
  dataRoot: string,
  slug: string,
  researchId: string,
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  const cid = correlationId();
  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const row = research.getResearch(db, researchId);
    if (row === null) return err('RESEARCH_NOT_FOUND', cid, { researchId });
    if (!mayAbandon(row.status)) {
      return err('RESEARCH_STEP_INVALID', cid, { status: row.status, want: 'abandon' });
    }
    research.updateResearchStatus(db, researchId, 'abandoned', Date.now());
    const updated = research.getResearch(db, researchId);
    if (updated === null) return err('RESEARCH_UNEXPECTED', cid, { researchId });
    return ok(viewOf(db, updated, await load()), cid);
  } finally {
    db.close();
  }
}

/**
 * 刪一次研究的紀錄（ADR-0033 D15／Q7）。
 *
 * **刪的是對話、規劃、方向**。這一版還沒有圖上的東西可以留或不留
 * （蒐集與建圖在 Stage 20／22），但規則現在就定好：**進行中的刪不掉**，先放棄。
 */
export async function deleteResearch(
  dataRoot: string,
  slug: string,
  researchId: string,
): Promise<Result<{ readonly id: string }>> {
  const cid = correlationId();
  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const row = research.getResearch(db, researchId);
    if (row === null) return err('RESEARCH_NOT_FOUND', cid, { researchId });
    if (!mayDelete(row.status)) {
      return err('RESEARCH_STEP_INVALID', cid, { status: row.status, want: 'delete' });
    }
    research.deleteResearch(db, researchId);
    return ok({ id: researchId }, cid);
  } finally {
    db.close();
  }
}

// ── 讀 ──────────────────────────────────────────────────────

export async function getResearchView(
  dataRoot: string,
  slug: string,
  researchId: string,
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  const cid = correlationId();
  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const row = research.getResearch(db, researchId);
    if (row === null) return err('RESEARCH_NOT_FOUND', cid, { researchId });
    return ok(viewOf(db, row, await load()), cid);
  } finally {
    db.close();
  }
}

/** 歷次紀錄那一欄（新的在前）。**這一版只有研究**，匯入與舊的擴展還在作業那一支。 */
export async function listResearchViews(
  dataRoot: string,
  slug: string,
  limit = 20,
  load: ProvidersLoader = loadProviders,
): Promise<Result<readonly ResearchView[]>> {
  const cid = correlationId();
  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const providers = await load();
    return ok(
      research.listResearch(db, limit).map((row) => viewOf(db, row, providers)),
      cid,
    );
  } finally {
    db.close();
  }
}
