/**
 * 「研究」的規劃那一半與整次研究的生命週期（ADR-0033、REQ-0009）。
 *
 * ```
 * POST /research                → 開一次研究（**一次模型呼叫都沒有**，只跑全文檢索）
 *          ↓  談一輪、改方向、再談一輪…（Stage 19）
 * POST /research/:id/start      → 閘門一：方向落成一張表，**蒐集開始**（Stage 20）
 *          ↓  蒐集、等你、閘門二在 `research-collect.ts`；確認與建圖是 Stage 22
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
 * | 閘門一 | 花：從這裡開始找來源（`research-collect.ts`）|
 *
 * ## 方向表在閘門一才落成
 *
 * 規劃期間的方向住在 `research.plan_json`（人改過的標 `human`）。閘門一按下去的那一刻，
 * 它落成 `research_direction` 一條一列 —— 之後的蒐集、統計、確認都對著那張表（D5）。
 * **模型提過、使用者刪掉的也一起落成**（`adopted = 0`）：模型提了哪些、你留了哪些，
 * 是這次研究的一部分（跟 `run_angle` 保留沒被勾的角度同一個理由）。
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  normalizeDirection,
  normalizePlan,
  missingFor,
  TASK_PLAN,
  type CapabilityFlag,
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
} from '../domain/research/index.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as research from '../infrastructure/db/repositories/research-repo.js';
import { modelLogPath } from '../infrastructure/fs/model-log.js';
import { casesDir } from '../infrastructure/fs/paths.js';
import { loadProviders } from '../infrastructure/providers/registry.js';
import { correlationId, newId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';
import { prepareSandbox, scanSandbox } from './agent-sandbox.js';
import { recordModelCall } from './model-call-log.js';
import { checkFindSources, launchCollect } from './research-collect.js';
import {
  hitsOf,
  openResearchCase,
  planOf,
  viewOf,
  type DirectionView,
  type PlanView,
  type ProvidersLoader,
  type ResearchHit,
  type ResearchView,
} from './research-view.js';
import * as registry from './run-registry.js';
import {
  MAX_HIT_EXCERPT_CHARS,
  PLAN_SCHEMA,
  PLAN_SYSTEM,
  planUser,
  type PlanHit,
  type PlanTurn,
} from './research-prompts.js';
import { searchCase } from './search-service.js';

/** 相關性命中最多顯示幾份。**這一步不花錢，但畫面要放得下**（R1）。 */
export const MAX_HITS = 5;

/** 一輪規劃對話等多久。CLI 那一條會邊查邊談，所以比一般對話久。 */
export const PLAN_TIMEOUT_MS = 180_000;

/**
 * 畫面上的形狀住在 `research-view.ts`（規劃與蒐集回的是同一份）。**從這裡轉出去**，
 * 讓路由與測試仍然只認得一個入口。
 */
export type {
  CandidateView,
  CollectView,
  DirectionView,
  FrozenDirection,
  MessageView,
  PlanService,
  PlanView,
  ProvidersLoader,
  ResearchHit,
  ResearchView,
  ServiceView,
} from './research-view.js';

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

  const db = await openResearchCase(dataRoot, slug);
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
  const db = await openResearchCase(dataRoot, slug);
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

    // **沙箱先建好**（`agent-sandbox.ts` 的檔頭）：Stage 19 漏了這一步，走 Claude Code 的每一輪都會
    // 因為工作目錄不存在而失敗，畫面上寫的是「沒設定」。
    const sandbox = planSandbox(dataRoot, slug, researchId);
    await prepareSandbox(sandbox);
    const call = await planner.run({ prompt: user, cwd: sandbox, timeoutMs: PLAN_TIMEOUT_MS });
    const connection = providers.connectionOf('plan');

    await recordModelCall(providers, join(casesDir(dataRoot), slug), {
      task: 'plan',
      role: 'agent',
      model: planner.name,
      runId: researchId,
      correlationId: cid,
      system: PLAN_SYSTEM,
      user,
      text: call.kind === 'ok' ? call.value : null,
      errorDetail: call.kind === 'error' ? call.detail : null,
      ok: call.kind === 'ok',
      code: call.kind === 'error' ? call.code : null,
      elapsedMs: call.cost.elapsedMs,
      costUsd: call.cost.costUsd,
    });

    // **成功失敗都掃**：規劃對話走 Claude Code 時跟找來源同一套 `--tools` 限制，沙箱是備援。
    const violations = await scanSandbox(sandbox);

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

    if (violations.length > 0) {
      logger.error('規劃對話的沙箱裡出現了抓取產物', { researchId, count: violations.length });
      research.insertMessage(db, { ...common, content: '', code: 'PROVIDER_SANDBOX_VIOLATION' });
      return err('PROVIDER_SANDBOX_VIOLATION', cid, { researchId });
    }

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

/** `<專題>\agent\research\<研究>\plan\`（storage-layout：agent 的沙箱；蒐集的在同一層的 `collect\`）。 */
function planSandbox(dataRoot: string, slug: string, researchId: string): string {
  return join(casesDir(dataRoot), slug, 'agent', 'research', researchId, 'plan');
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
  const db = await openResearchCase(dataRoot, slug);
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
 * 閘門一：**照這份規劃開始**（R5）。按下去之前，一次搜尋、一次擷取都沒有發生過。
 *
 * 順序是刻意的：
 *
 * 1. **先確定找來源那一支配得上**（`checkFindSources`）—— 配不上的話研究還停在規劃中，
 *    方向也還沒落成，改完設定再按一次就好。先落成再檢查的話，一次失敗會留下一張
 *    「已經定案、卻沒有開始」的方向表
 * 2. 當時的規劃落成方向表（模型提過、你刪掉的也各一列）
 * 3. 狀態換成「蒐集中」，開一筆蒐集作業（`launchCollect`）
 */
export async function startCollecting(
  dataRoot: string,
  slug: string,
  researchId: string,
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  const cid = correlationId();
  const db = await openResearchCase(dataRoot, slug);
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

    const providers = await load();
    const agent = await checkFindSources(providers, cid);
    if (!agent.ok) return agent;

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
    await launchCollect(db, {
      dataRoot,
      slug,
      researchId,
      providers,
      agent: agent.data,
      correlationId: cid,
    });
    const updated = research.getResearch(db, researchId);
    if (updated === null) return err('RESEARCH_UNEXPECTED', cid, { researchId });
    return ok(viewOf(db, updated, providers), cid);
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
  const db = await openResearchCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const row = research.getResearch(db, researchId);
    if (row === null) return err('RESEARCH_NOT_FOUND', cid, { researchId });
    if (!mayAbandon(row.status)) {
      return err('RESEARCH_STEP_INVALID', cid, { status: row.status, want: 'abandon' });
    }
    // **還在蒐集就先叫它停**（取消 ＝ 殺子程序 ＋ 停爬蟲，已抓的留著）。它收尾時換狀態是條件式的
    // （`moveResearchIf`），所以不會把「放棄了」蓋回「等你」。
    if (row.collectRunId !== null) registry.cancel(row.collectRunId);
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
 * **刪的是**：對話、規劃、方向、候選，以及那一次的模型呼叫紀錄（診斷開著的話，那裡面有整段對話
 * 與每一次找來源的提示詞）。**不刪的**：抓回來、上傳進來的資料，以及那幾筆作業 ——
 * 它們是「這些東西來自哪裡」的唯一紀錄（要拿掉寫進去的東西，用「復原這次作業」，ADR-0023）。
 *
 * **進行中的刪不掉**，先放棄；放棄之後蒐集那一筆還在收尾的那幾秒也刪不掉。
 */
export async function deleteResearch(
  dataRoot: string,
  slug: string,
  researchId: string,
): Promise<Result<{ readonly id: string }>> {
  const cid = correlationId();
  const db = await openResearchCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const row = research.getResearch(db, researchId);
    if (row === null) return err('RESEARCH_NOT_FOUND', cid, { researchId });
    if (!mayDelete(row.status)) {
      return err('RESEARCH_STEP_INVALID', cid, { status: row.status, want: 'delete' });
    }
    const runIds = research.listResearchRunIds(db, researchId);
    if (runIds.some((id) => registry.isActive(id))) {
      return err('RESEARCH_STEP_INVALID', cid, { status: row.status, want: 'delete', why: 'live' });
    }
    research.deleteResearch(db, researchId);
    // 規劃對話記在研究的 id 底下，蒐集記在每一筆作業的 id 底下（`model-calls\<id>.jsonl`）。
    // **一個檔一個檔地刪**（不是整個資料夾）；沒有那個檔（診斷沒開）就是沒有。
    const folder = join(casesDir(dataRoot), slug);
    for (const id of [researchId, ...runIds]) {
      await rm(modelLogPath(folder, id), { force: true });
    }
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
  const db = await openResearchCase(dataRoot, slug);
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
  const db = await openResearchCase(dataRoot, slug);
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
