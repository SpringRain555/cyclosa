/**
 * 研究的蒐集那一段（Stage 20–21，ADR-0033 D3／D7／D8／D9、REQ-0009 R7–R16）。
 *
 * ```
 * 閘門一（research-service.startCollecting）→ launchCollect：一筆 kind='research' 的作業
 *     ① 每條方向各搜一次 → 候選表（同一個網址只有一列）
 *     ② 能抓的走唯一的擷取管線；依你的紀錄多半要登入的不去試 → 「要你拿」
 *     ③ 拿到的每一份初讀一次（Stage 21）：跟這次研究有沒有關、繁中標題與兩三句摘要
 * 作業結束 → 研究停在「等你」（沒有任何作業在跑）
 *     上傳對回候選（uploadCandidate → 自動開一筆只讀的作業）、標拿不到（markCandidateUnavailable）、
 *     繼續蒐集（resumeCollecting）
 * 閘門二「完成蒐集」（finishCollecting）→ 不再找、不再抓
 * ```
 *
 * ## 先把每一條都搜完，再開始抓
 *
 * 舊的擴展是「一條角度找完就抓完，再做下一條」。這裡反過來，理由有兩個：
 * **候選清單早一點完整** —— 你可以在它慢慢抓的時候，先去拿那幾篇要登入的；
 * 而兩條方向找到同一篇的時候，**先合併成一列再抓**，不會抓兩次。
 *
 * ## 研究與作業是兩件事（D3）
 *
 * 這一筆作業跑完（做完、部分完成、失敗、你按了取消）研究就換成「等你」；
 * **關掉程式時一起停的留在「蒐集中」**，下次打開畫面說「停在半路」、給一顆「繼續蒐集」（R13）。
 * 「繼續蒐集」開的是**新的一筆作業**，只做還沒做完的（`collectWork`）：已抓的不重抓。
 *
 * ## 這一段一條關聯都不寫（R12）
 *
 * 抓回來的候選就是資料節點（D8，閱讀器裡可以先讀），但**抽實體與關聯是閘門三之後的事**。
 * 這支檔案裡沒有任何一個呼叫點會寫 `edge`。
 */
import { join } from 'node:path';

import { levelOf, type ErrorCode } from '../domain/errors/codes.js';
import { settleRun, type RunStatus } from '../domain/ingest/state.js';
import { displayHost, normalizeUrl } from '../domain/ingest/url.js';
import {
  charge,
  chargeTask,
  EMPTY_BUDGET_STATE,
  EMPTY_TASK_COSTS,
  mayContinue,
  missingFor,
  normalizeDigest,
  normalizeResearchCandidates,
  TASK_DIGEST,
  TASK_FIND_SOURCES,
  type BudgetState,
  type SourceHints,
  type TaskCosts,
} from '../domain/provider/index.js';
import {
  accessPlan,
  COLLECT_BUDGET,
  collectWork,
  mayActOnCandidate,
  mayFinishCollecting,
  mayResumeCollecting,
  needsDigest,
  needsFetch,
  needsSearch,
  SEARCH_TIMEOUT_MS,
  statusAfterCollectRun,
  stopsDigesting,
  unavailableReasonOf,
  type AccessPlan,
  type CandidateAction,
} from '../domain/research/index.js';
import { withTransaction, type DatabaseSync } from '../infrastructure/db/database.js';
import { readCase, updateCaseStatus } from '../infrastructure/db/repositories/case-repo.js';
import { setItemDigest } from '../infrastructure/db/repositories/item-repo.js';
import * as research from '../infrastructure/db/repositories/research-repo.js';
import * as runs from '../infrastructure/db/repositories/run-repo.js';
import { readDerived } from '../infrastructure/fs/case-files.js';
import { casesDir } from '../infrastructure/fs/paths.js';
import { reindexTitleRank } from '../infrastructure/index/writer.js';
import { Crawler } from '../infrastructure/fetch/crawler.js';
import { loadProviders, type Providers } from '../infrastructure/providers/registry.js';
import type { AgentProvider, ChatProvider } from '../infrastructure/providers/types.js';
import { normaliseHost } from '../infrastructure/sources/catalog.js';
import { correlationId, newId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';
import { prepareSandbox, scanSandbox } from './agent-sandbox.js';
import { configuredIntervalMs } from './fetch-policy.js';
import { importFileInto, processOneUrl } from './ingest-service.js';
import { recordModelCall } from './model-call-log.js';
import {
  CANDIDATES_SCHEMA,
  CANDIDATES_SYSTEM,
  candidatesUser,
  DIGEST_SCHEMA,
  DIGEST_SYSTEM,
  digestUser,
} from './research-prompts.js';
import {
  openResearchCase,
  planOf,
  viewOf,
  type ProvidersLoader,
  type ResearchView,
} from './research-view.js';
import * as registry from './run-registry.js';
import { hintsFrom, listSources, type SourceRow } from './source-service.js';

function caseFolderOf(dataRoot: string, slug: string): string {
  return join(casesDir(dataRoot), slug);
}

/**
 * `<專題>\agent\runs\<作業>\<第幾條方向>\`（storage-layout：agent 的沙箱，跟舊的擴展同一種形狀）。
 *
 * **不要再往深裡放**：第一版是 `agent\research\<研究>\collect\<作業>\<第幾條>\`，多了兩個
 * 36 字元的 id，資料根放得夠深就超過 Windows 的工作目錄上限 —— 2026-09-23 實跑時伺服器
 * 就是這樣整個停掉的（`spawn-piped.ts` 的檔頭）。作業的 id 本來就全域唯一，它屬於哪一次研究
 * 記在 `run.research_id`。
 */
function collectSandbox(dataRoot: string, slug: string, runId: string, ord: number): string {
  return join(caseFolderOf(dataRoot, slug), 'agent', 'runs', runId, String(ord));
}

// ── 找來源那一支配不配得上 ──────────────────────────────────

/**
 * 找來源那一支**在開始之前**就要確定配得上（ADR-0006 第 3 條：配不上就停手）。
 *
 * 跟舊的擴展同一套檢查：有沒有設定、連不連得上、能力夠不夠，走 OpenAI 相容 API 的
 * 還要量過「會不會真的搜尋」（沒量過就在這裡量一次 —— 一個帶搜尋的小請求）。
 * **閘門一按下去之後、方向落成之前**跑它：配不上的話研究還停在規劃中，改完設定再按一次就好。
 */
export async function checkFindSources(
  providers: Providers,
  cid: string,
): Promise<Result<AgentProvider>> {
  // `task` 跟著每一個錯誤走：**畫面要說得出是哪一個任務沒設定、去哪裡改**（ErrorPanel）——
  // 閘門一同時檢查兩個任務，只說「模型還沒有設定」的話，使用者不知道該改哪一列。
  const who = { role: 'agent', task: 'find-sources' } as const;
  const agent = providers.agentFor({
    schema: CANDIDATES_SCHEMA,
    systemPrompt: CANDIDATES_SYSTEM,
    maxCostUsd: COLLECT_BUDGET.maxCostUsd,
  });
  if (agent === null) return err('PROVIDER_NOT_CONFIGURED', cid, who);

  const probe = await agent.probe();
  if (probe.kind === 'not-configured') return err('PROVIDER_NOT_CONFIGURED', cid, who);
  if (probe.kind === 'unreachable') {
    return err('PROVIDER_UNREACHABLE', cid, { ...who, at: probe.detail });
  }
  const match = missingFor(TASK_FIND_SOURCES, probe.capabilities);
  if (match.kind === 'missing') {
    return err('PROVIDER_CAPABILITY_MISSING', cid, {
      ...who,
      missing: match.flags,
      ...(match.context === null
        ? {}
        : { needContextTokens: match.context[0], haveContextTokens: match.context[1] }),
    });
  }

  if (agent.checkBrowse !== undefined && agent.browseReport !== undefined) {
    let browse = await agent.browseReport();
    if (browse.state === 'unchecked') {
      const measured = await agent.checkBrowse();
      if (measured.kind === 'error') return err(measured.code, cid, who);
      browse = measured.value;
    }
    if (browse.state === 'no') {
      return err('PROVIDER_CAPABILITY_MISSING', cid, { ...who, missing: ['browse'] });
    }
  }
  return ok(agent, cid);
}

// ── 初讀那一支配不配得上（Stage 21）─────────────────────────

/**
 * 初讀那一支**也在開始之前**確定配得上 —— 跟抽取同一套檢查（`expand-service.ts` 的閘門）：
 * 有沒有設定、連不連得上、能力夠不夠（`json_schema`、context），格式保證是哪一種
 * （線上端點沒量過就在這裡量一次 —— 一到兩個很小的請求；量出 `none` 就停）。
 *
 * **沒設定就擋下來、說是這一個任務**（ADR-0033「你定的」）：初讀每一份候選都讀，
 * 不能等到全部抓完才發現沒有東西可以讀它們。
 */
export async function checkDigest(
  providers: Providers,
  cid: string,
): Promise<Result<ChatProvider>> {
  const who = { role: 'chat', task: 'digest' } as const;
  const chat = providers.chatFor('digest');
  if (chat === null) return err('PROVIDER_NOT_CONFIGURED', cid, who);
  const probe = await chat.probe();
  if (probe.kind === 'not-configured') return err('PROVIDER_NOT_CONFIGURED', cid, who);
  if (probe.kind === 'unreachable') {
    return err('PROVIDER_UNREACHABLE', cid, { ...who, at: probe.detail });
  }
  const match = missingFor(TASK_DIGEST, probe.capabilities);
  if (match.kind === 'missing') {
    return err('PROVIDER_CAPABILITY_MISSING', cid, {
      ...who,
      missing: match.flags,
      ...(match.context === null
        ? {}
        : { needContextTokens: match.context[0], haveContextTokens: match.context[1] }),
    });
  }
  let json = await chat.jsonMode();
  if (json.mode === 'unchecked' && chat.checkJson !== undefined) {
    const measured = await chat.checkJson();
    if (measured.kind === 'error') return err(measured.code, cid, who);
    json = measured.value;
  }
  if (json.mode === 'none') {
    return err('PROVIDER_JSON_UNSUPPORTED', cid, { ...who, detail: json.detail });
  }
  return ok(chat, cid);
}

// ── 開一筆蒐集作業 ──────────────────────────────────────────

/** 一個網址抓之前的預期（依來源網站那一頁的判斷，`accessPlan`）。 */
type AccessOf = (url: string) => AccessPlan;

function accessFrom(rows: readonly SourceRow[]): AccessOf {
  const byHost = new Map(rows.map((r) => [r.host, r]));
  return (url) => {
    const row = byHost.get(normaliseHost(displayHost(url)));
    return accessPlan(row?.verdict ?? null, row?.expected === 'login' || row?.expected === 'mixed');
  };
}

export interface LaunchInput {
  readonly dataRoot: string;
  readonly slug: string;
  readonly researchId: string;
  readonly providers: Providers;
  /** `null` ＝ 這一次只剩要抓的（「繼續蒐集」而方向都搜完了）—— 那不需要找來源的服務 */
  readonly agent: AgentProvider | null;
  /**
   * 初讀的那一支（Stage 21，`checkDigest` 過了的）。**`null` 的時候不讀** —— 目前只有測試會這樣開；
   * 閘門一與「繼續蒐集」都先檢查過它。
   */
  readonly digest: ChatProvider | null;
  /**
   * `'digest'` ＝ **只讀，不搜、不抓**：你上傳一份之後自動開的那一筆。
   * 分開的理由是花費：順手重試一條失敗的搜尋會花 Claude Code 的額度，而你按的是「上傳」。
   */
  readonly only?: 'digest';
  readonly correlationId: string;
}

/**
 * 開一筆蒐集作業並在背景跑。**呼叫端先把研究換成 `collecting`**，這一支只管作業。
 *
 * 背景那一段**自己開一條資料庫連線**：這一條（呼叫端的）在請求結束時就關掉了。
 */
export async function launchCollect(db: DatabaseSync, input: LaunchInput): Promise<string> {
  const row = research.getResearch(db, input.researchId);
  const topic = row?.topic ?? '';
  const pending =
    input.only === 'digest'
      ? []
      : research.listDirections(db, input.researchId).filter(needsSearch);

  /**
   * 來源清單**一次作業讀一次**：`listSources` 會逐一打開每個專題的資料庫。
   * 同一份清單給兩件事用 —— 提示詞裡的四段、每個候選抓之前的預期。
   */
  const listed = await listSources(input.dataRoot);
  const rows = listed.ok ? listed.data : [];

  const runId = newId();
  const now = Date.now();
  runs.insertRun(db, {
    id: runId,
    kind: 'research',
    label: topic,
    // **這一筆的「一項」是一條方向或一份初讀**。初讀有幾份要等抓完才知道 —— 那時候再補（`updateRunTotal`）。
    // 抓了幾份在逐項表與候選表上。
    total: pending.length,
    correlationId: input.correlationId,
    now,
    topic,
    providers: JSON.stringify({
      agent: input.agent?.name ?? null,
      digest: input.digest?.name ?? null,
    }),
    researchId: input.researchId,
  });
  research.setCollectRun(db, input.researchId, runId, now);
  const caseStatus = readCase(db)?.status;
  if (caseStatus === 'new' || caseStatus === 'ready') updateCaseStatus(db, 'collecting', now);

  const state = registry.register(runId);
  // **不 await。** 這條路徑刻意是「開始了」而不是「做完了」（同匯入與擴展）。
  void processCollect({
    dataRoot: input.dataRoot,
    slug: input.slug,
    researchId: input.researchId,
    state,
    providers: input.providers,
    agent: input.agent,
    digest: input.digest,
    only: input.only ?? null,
    hints: hintsFrom(rows),
    accessOf: accessFrom(rows),
  }).catch((e: unknown) => {
    logger.error('蒐集作業意外中止', {
      correlationId: input.correlationId,
      runId,
      reason: String(e),
    });
  });
  return runId;
}

// ── 背景執行 ────────────────────────────────────────────────

interface CollectContext {
  readonly dataRoot: string;
  readonly slug: string;
  readonly researchId: string;
  readonly state: registry.ActiveRun;
  readonly providers: Providers;
  readonly agent: AgentProvider | null;
  readonly digest: ChatProvider | null;
  readonly only: 'digest' | null;
  readonly hints: SourceHints;
  readonly accessOf: AccessOf;
}

async function processCollect(ctx: CollectContext): Promise<void> {
  const { state } = ctx;
  const opened = await openResearchCase(ctx.dataRoot, ctx.slug);
  if (typeof opened === 'string') {
    // 開不了資料庫就沒有地方可以寫結果。**作業列留在「排隊中」**，下次打開時畫面說它停在半路。
    logger.error('蒐集作業開不了專題的資料庫', { runId: state.runId, code: opened });
    registry.unregister(state.runId);
    return;
  }
  const db = opened;
  // **整個函式包在 try 裡**（同 `processExpansion`）：前置那幾行丟例外的話連線會一直開著。
  try {
    const folder = caseFolderOf(ctx.dataRoot, ctx.slug);
    const startedAt = Date.now();
    const abort = new AbortController();
    const crawler = new Crawler({
      intervalMs: configuredIntervalMs(),
      onEvent: (e) => state.channel.emit({ type: 'throttled', host: e.host, waitedMs: e.waitedMs }),
      onBackOff: (e) =>
        state.channel.emit({ type: 'throttled', host: e.host, waitedMs: e.delayMs }),
    });
    // **取消 ＝ 殺子程序 ＋ 停爬蟲。已寫入的保留**（同擴展）。
    state.cancellable = {
      stop: () => {
        abort.abort();
        crawler.stop();
      },
    };

    research.resetFetching(db, ctx.researchId, startedAt);
    runs.startRun(db, state.runId, startedAt);
    const row = research.getResearch(db, ctx.researchId);
    const plan = planOf(row?.planJson ?? '{}');
    const pending =
      ctx.only === 'digest' ? [] : research.listDirections(db, ctx.researchId).filter(needsSearch);
    state.channel.emit({ type: 'started', runId: state.runId, total: pending.length });

    let budget: BudgetState = EMPTY_BUDGET_STATE;
    // 逐任務的那一份（v11）：總數還是 `budget`（上限只看總數），這一份拆開給人看（R29）。
    let taskCosts: TaskCosts = EMPTY_TASK_COSTS;
    let searched = 0;
    let searchFailed = 0;
    let fatal: ErrorCode | null = null;

    // ① 每條方向各搜一次。
    for (const direction of pending) {
      if (state.cancelled) break;
      // **暫停停在方向與方向之間。** 一次搜尋中途砍掉的話，花掉的那一次就白花了。
      await state.gate();
      if (state.cancelled) break;
      if (ctx.agent === null) break;

      budget = { ...budget, elapsedMs: Date.now() - startedAt };
      if (mayContinue(budget, COLLECT_BUDGET).kind !== 'ok') {
        // **沒有被嘗試過**，所以是「失敗、可以重來」—— 「繼續蒐集」會接著做。
        research.markDirectionSearched(db, {
          id: direction.id,
          state: 'failed',
          code: 'PROVIDER_BUDGET_EXCEEDED',
          now: Date.now(),
        });
        searchFailed += 1;
        state.channel.emit({
          type: 'direction',
          directionId: direction.id,
          title: direction.title,
          found: 0,
          code: 'PROVIDER_BUDGET_EXCEEDED',
        });
        continue;
      }

      const outcome = await searchDirection(db, {
        ctx,
        agent: ctx.agent,
        direction,
        topic: row?.topic ?? '',
        relation: plan.relation,
        outOfScope: plan.outOfScope,
        abort,
        startedAt,
        budget,
        taskCosts,
      });
      budget = outcome.budget;
      taskCosts = outcome.taskCosts;
      runs.updateRunBudget(
        db,
        state.runId,
        budget.requests,
        budget.costUsd,
        budget.unpriced,
        taskCosts,
      );

      if (outcome.interrupted) {
        // 你按了取消、子程序被殺掉 —— **這一條沒有搜完**，留在「還沒搜」，下一次接著做。
        break;
      }
      const failed = outcome.code !== null && levelOf(outcome.code) !== 'notice';
      research.markDirectionSearched(db, {
        id: direction.id,
        state: failed ? 'failed' : 'done',
        code: outcome.code,
        now: Date.now(),
      });
      if (failed) searchFailed += 1;
      else searched += 1;
      state.channel.emit({
        type: 'direction',
        directionId: direction.id,
        title: direction.title,
        found: outcome.found,
        code: outcome.code,
      });
      // **只有 `error` 級的碼會讓整批停下來**（目前只有沙箱違規）—— 同擴展。
      if (outcome.fatal) {
        fatal = outcome.code;
        break;
      }
    }

    // ② 能抓的抓。**已抓的不重抓**（R13）：只挑還沒抓的與被限流的。
    if (!state.cancelled && fatal === null && ctx.only !== 'digest') {
      for (const candidate of research.listCandidates(db, ctx.researchId).filter(needsFetch)) {
        if (state.cancelled || crawler.isStopped) break;
        await state.gate();
        if (state.cancelled) break;
        await fetchCandidate(db, { ctx, folder, crawler, candidate });
      }
    }

    // ③ 初讀（Stage 21）：拿到的每一份讀一次。**讀好的不重讀**（`needsDigest`）。
    let digested = 0;
    let digestFailed = 0;
    if (ctx.digest !== null && !state.cancelled && fatal === null) {
      const directions = research
        .listDirections(db, ctx.researchId)
        .filter((d) => d.adopted)
        .map((d) => d.title);
      const tried = new Set<string>();
      let stop = false;
      // **讀完一輪再查一次**：作業跑著的時候你上傳的那幾份，也在這一筆裡讀掉。
      // `tried` 讓一份讀失敗的不會在同一筆裡被重讀（那要等「繼續蒐集」）。
      while (!stop && !state.cancelled) {
        const batch = research
          .listCandidates(db, ctx.researchId)
          .filter((c) => needsDigest(c) && !tried.has(c.id));
        if (batch.length === 0) break;
        runs.updateRunTotal(db, state.runId, pending.length + tried.size + batch.length);
        for (const candidate of batch) {
          if (state.cancelled) break;
          // **暫停與取消停在兩份之間** —— 一次讀到一半砍掉的話，花掉的那一次就白花了。
          await state.gate();
          if (state.cancelled) break;
          tried.add(candidate.id);

          budget = { ...budget, elapsedMs: Date.now() - startedAt };
          if (mayContinue(budget, COLLECT_BUDGET).kind !== 'ok') {
            // **沒有被嘗試過**，所以是可以重來的失敗 —— 「繼續蒐集」會接著讀。
            research.setCandidateDigest(db, {
              id: candidate.id,
              relevance: null,
              why: '',
              code: 'PROVIDER_BUDGET_EXCEEDED',
              now: Date.now(),
            });
            digestFailed += 1;
            state.channel.emit({
              type: 'digest',
              candidateId: candidate.id,
              itemId: candidate.itemId,
              relevance: null,
              code: 'PROVIDER_BUDGET_EXCEEDED',
            });
            continue;
          }

          const outcome = await digestCandidate(db, {
            ctx,
            chat: ctx.digest,
            candidate,
            folder,
            topic: row?.topic ?? '',
            relation: plan.relation,
            directions,
            abort,
            startedAt,
            budget,
            taskCosts,
          });
          budget = outcome.budget;
          taskCosts = outcome.taskCosts;
          runs.updateRunBudget(
            db,
            state.runId,
            budget.requests,
            budget.costUsd,
            budget.unpriced,
            taskCosts,
          );
          // 你按了取消、請求被中斷 —— **這一份沒讀完**，留在「還沒讀」，下一次接著讀。
          if (outcome.interrupted) break;
          if (outcome.code === null) digested += 1;
          else digestFailed += 1;
          // 被限流、金鑰被拒、連不上：接下來每一份都會一樣，這一筆不再讀下去。
          if (stopsDigesting(outcome.code)) {
            stop = true;
            break;
          }
        }
      }
    }

    const now = Date.now();
    research.resetFetching(db, ctx.researchId, now);
    runs.cancelPendingItems(db, state.runId, now);

    // **這一筆的成敗看模型那兩件事做得怎樣**：方向搜得怎樣、拿到的讀得怎樣。
    // 抓不到的候選不是失敗，是「要你拿」—— 那是研究的日常。
    const succeeded = searched + digested;
    const failedCount = searchFailed + digestFailed;
    const settled = settleRun(succeeded, failedCount);
    const status: RunStatus = state.cancelled
      ? 'cancelled'
      : fatal !== null
        ? 'failed'
        : settled === 'complete'
          ? 'done'
          : settled === 'complete-partial'
            ? 'partial'
            : 'failed';
    const endedReason = status === 'cancelled' ? state.cancelReason : null;
    runs.settleRunRow(db, {
      id: state.runId,
      status,
      succeeded,
      failed: failedCount,
      errorCode: fatal,
      endedReason,
      now,
    });

    // 研究停在哪（D3）。**條件式的**：你可能已經在另一個請求裡按了「放棄」。
    const next = statusAfterCollectRun(endedReason);
    if (next !== 'collecting') research.moveResearchIf(db, ctx.researchId, 'collecting', next, now);

    reindexTitleRank(db);
    if (readCase(db)?.status === 'collecting') updateCaseStatus(db, 'ready', now);
    state.channel.emit({ type: 'settled', status, succeeded, failed: failedCount });
  } finally {
    registry.unregister(state.runId);
    db.close();
  }
}

interface SearchInput {
  readonly ctx: CollectContext;
  readonly agent: AgentProvider;
  readonly direction: research.ResearchDirectionRow;
  readonly topic: string;
  readonly relation: string;
  readonly outOfScope: readonly string[];
  readonly abort: AbortController;
  readonly startedAt: number;
  readonly budget: BudgetState;
  readonly taskCosts: TaskCosts;
}

interface SearchOutcome {
  readonly budget: BudgetState;
  readonly taskCosts: TaskCosts;
  /** 這一次搜到幾個（**含別的方向也找到的**） */
  readonly found: number;
  /** `null` ＝ 乾淨；通知級（超過上限）＝ 搜完了但要說一聲；其餘 ＝ 這一條搜失敗 */
  readonly code: ErrorCode | null;
  readonly fatal: boolean;
  /** 被取消打斷 —— 這一條不算搜過 */
  readonly interrupted: boolean;
}

/** 一條方向：找來源 → 掃沙箱 → 候選寫進表。**這一步不抓任何東西。** */
async function searchDirection(db: DatabaseSync, input: SearchInput): Promise<SearchOutcome> {
  const { ctx, direction } = input;
  const sandbox = collectSandbox(ctx.dataRoot, ctx.slug, ctx.state.runId, direction.ord);
  await prepareSandbox(sandbox);

  const prompt = candidatesUser({
    topic: input.topic,
    relation: input.relation,
    direction: {
      title: direction.title,
      what: direction.what,
      expect: direction.expect,
      keywords: direction.keywords,
    },
    outOfScope: input.outOfScope,
    hints: ctx.hints,
  });
  // 建沙箱是一次 await —— 你可能正好在這時候按了取消。**那就不要開始這一次搜尋**：
  // 它還沒花錢，而這一條留在「還沒搜」，下一次接著做。
  if (ctx.state.cancelled) {
    return {
      budget: input.budget,
      taskCosts: input.taskCosts,
      found: 0,
      code: null,
      fatal: false,
      interrupted: true,
    };
  }
  const remaining = input.startedAt + COLLECT_BUDGET.timeoutMs - Date.now();
  const call = await input.agent.run(
    {
      prompt,
      cwd: sandbox,
      // 一次搜尋的上限，**也不超過這一筆作業還剩的時間**（兩個逾時各算各的會超過牆鐘上限）。
      timeoutMs: Math.max(1000, Math.min(SEARCH_TIMEOUT_MS, remaining)),
    },
    input.abort.signal,
  );

  // agent 這一條記的是**原始文字**（子程序吐出來的東西），同擴展。
  await recordModelCall(ctx.providers, caseFolderOf(ctx.dataRoot, ctx.slug), {
    task: 'find-sources',
    role: 'agent',
    model: input.agent.name,
    runId: ctx.state.runId,
    correlationId: ctx.state.runId,
    system: CANDIDATES_SYSTEM,
    user: prompt,
    text: call.kind === 'ok' ? call.value : null,
    errorDetail: call.kind === 'error' ? call.detail : null,
    ok: call.kind === 'ok',
    code: call.kind === 'error' ? call.code : null,
    elapsedMs: call.cost.elapsedMs,
    costUsd: call.cost.costUsd,
  });
  const budget = charge(input.budget, call.cost.costUsd, Date.now() - input.startedAt);
  const taskCosts = chargeTask(input.taskCosts, 'find-sources', call.cost.costUsd);

  // **沙箱一定要掃，成功失敗都掃**（`agent-sandbox.ts` 的檔頭）。
  const violations = await scanSandbox(sandbox);
  if (violations.length > 0) {
    logger.error('agent 沙箱裡出現了抓取產物', {
      runId: ctx.state.runId,
      direction: direction.ord,
      count: violations.length,
    });
    return {
      budget,
      taskCosts,
      found: 0,
      code: 'PROVIDER_SANDBOX_VIOLATION',
      fatal: true,
      interrupted: false,
    };
  }

  if (call.kind === 'error') {
    return {
      budget,
      taskCosts,
      found: 0,
      code: call.code,
      fatal: false,
      interrupted: ctx.state.cancelled,
    };
  }

  let raw: unknown;
  try {
    raw = (JSON.parse(call.value) as { candidates?: unknown } | null)?.candidates;
  } catch {
    return {
      budget,
      taskCosts,
      found: 0,
      code: 'PROVIDER_OUTPUT_UNPARSEABLE',
      fatal: false,
      interrupted: false,
    };
  }

  const batch = normalizeResearchCandidates(raw);
  const now = Date.now();
  let found = 0;
  for (const draft of batch.candidates) {
    // **正規化過的網址才是去重的鍵**（同一條擷取管線的那一套，`domain/ingest/url.ts`）。
    const parsed = normalizeUrl(draft.url);
    if (parsed.kind !== 'ok') continue;
    const access = ctx.accessOf(parsed.url);
    research.addCandidate(db, {
      id: newId(),
      researchId: ctx.researchId,
      directionId: direction.id,
      url: parsed.url,
      title: draft.title,
      why: draft.why,
      bib: draft.bib,
      expectedAccess: access.expected,
      // **依你的紀錄多半要登入（或會出驗證頁）的不去試**，直接列成「要你拿」（R8）。
      acquisition: access.skip ? 'needs-user' : 'found',
      now,
    });
    found += 1;
  }
  return {
    budget,
    taskCosts,
    found,
    code: batch.overflow ? 'RESEARCH_CANDIDATES_OVERFLOW' : null,
    fatal: false,
    interrupted: false,
  };
}

/** 一個候選：走唯一的擷取管線（節流、robots、快照、manifest 都在那一支裡面）。 */
async function fetchCandidate(
  db: DatabaseSync,
  input: {
    readonly ctx: CollectContext;
    readonly folder: string;
    readonly crawler: Crawler;
    readonly candidate: research.ResearchCandidateRow;
  },
): Promise<void> {
  const { ctx, candidate } = input;
  research.setAcquisition(db, {
    id: candidate.id,
    acquisition: 'fetching',
    code: null,
    now: Date.now(),
  });
  const runItemId = newId();
  const host = displayHost(candidate.url) || null;
  runs.insertRunItem(db, { id: runItemId, runId: ctx.state.runId, requested: candidate.url, host });

  // **同一條擷取管線。** agent 只給了網址，抓是我們抓的。向量也在那一支裡寫（有設定的話）。
  const outcome = await processOneUrl(
    db,
    input.folder,
    input.crawler,
    ctx.state.runId,
    { id: runItemId, url: candidate.url },
    ctx.providers,
  );
  ctx.state.channel.emit({
    type: 'item',
    runItemId,
    requested: candidate.url,
    host,
    outcome: outcome.outcome,
    code: outcome.code,
    itemId: outcome.itemId,
  });

  const now = Date.now();
  if (outcome.outcome === 'ok' || outcome.outcome === 'duplicate') {
    // 抓到了（或專題裡本來就有）—— **它現在就是一份資料**，閱讀器裡可以先讀（D8）。
    research.setAcquisition(db, {
      id: candidate.id,
      acquisition: 'fetched',
      code: outcome.code,
      itemId: outcome.itemId,
      now,
    });
    return;
  }
  if (ctx.state.cancelled && outcome.code === 'FETCH_UNEXPECTED') {
    // 爬蟲在這一刻被停掉了（你按了取消）—— **這一份沒有被試過**，不是「拿不到」。
    research.setAcquisition(db, {
      id: candidate.id,
      acquisition: 'found',
      code: null,
      itemId: outcome.itemId,
      now,
    });
    return;
  }
  // **抓不到的照實說是哪一種**（R9）：每一種是既有的擷取錯誤碼，不是一個「失敗」。
  research.setAcquisition(db, {
    id: candidate.id,
    acquisition: 'needs-user',
    code: outcome.code,
    itemId: outcome.itemId,
    now,
  });
}

interface DigestInput {
  readonly ctx: CollectContext;
  readonly chat: ChatProvider;
  readonly candidate: research.ResearchCandidateRow;
  readonly folder: string;
  readonly topic: string;
  readonly relation: string;
  /** 這次研究採用的方向標題（讓模型說得出「跟哪一條有關」）*/
  readonly directions: readonly string[];
  readonly abort: AbortController;
  readonly startedAt: number;
  readonly budget: BudgetState;
  readonly taskCosts: TaskCosts;
}

interface DigestOutcome {
  readonly budget: BudgetState;
  readonly taskCosts: TaskCosts;
  /** `null` ＝ 讀好了；其餘是這一份讀失敗的原因（已經寫進候選那一列）*/
  readonly code: ErrorCode | null;
  /** 被取消打斷 —— 這一份不算讀過，也沒有寫任何東西 */
  readonly interrupted: boolean;
}

/**
 * 一份候選：讀正文開頭 → 問模型 → 判斷寫進候選、繁中寫進那一份資料（Stage 21，R14–R16）。
 *
 * **正文是別人網站上的文字**：提示詞把它夾在標記裡、明說是資料不是指令，輸出走 schema，
 * 而且這一步**什麼都不寫進圖** —— 它的結果只是確認畫面上的預設值與一段給人看的繁中（`DIGEST_SYSTEM`）。
 * 模型回的東西一律先過 `normalizeDigest`（外部輸入）。
 */
async function digestCandidate(db: DatabaseSync, input: DigestInput): Promise<DigestOutcome> {
  const { ctx, candidate } = input;
  const itemId = candidate.itemId;
  const failWith = (code: ErrorCode, budget: BudgetState, taskCosts: TaskCosts): DigestOutcome => {
    research.setCandidateDigest(db, {
      id: candidate.id,
      relevance: null,
      why: '',
      code,
      now: Date.now(),
    });
    ctx.state.channel.emit({
      type: 'digest',
      candidateId: candidate.id,
      itemId,
      relevance: null,
      code,
    });
    return { budget, taskCosts, code, interrupted: false };
  };

  // 沒有正文可讀（掃描的 PDF、抽不出字的圖）：**不花一次呼叫**，而且「繼續蒐集」不再讀它（`needsDigest`）。
  const derived = itemId === null ? null : await readDerived(input.folder, itemId);
  if (itemId === null || derived === null || derived.text.trim().length === 0) {
    return failWith('PARSE_EMPTY_CONTENT', input.budget, input.taskCosts);
  }

  const user = digestUser({
    topic: input.topic,
    relation: input.relation,
    directions: input.directions,
    // 抽取出來的標題比搜尋結果上的準（那是這一份自己說它叫什麼）；抽不到才用搜尋結果上的。
    title: derived.title.trim().length > 0 ? derived.title : candidate.title,
    url: candidate.url,
    excerpt: derived.text,
  });
  const call = await input.chat.json(
    { system: DIGEST_SYSTEM, user, schema: DIGEST_SCHEMA },
    input.abort.signal,
  );
  await recordModelCall(ctx.providers, input.folder, {
    task: 'digest',
    role: 'chat',
    model: input.chat.name,
    runId: ctx.state.runId,
    correlationId: ctx.state.runId,
    itemId,
    system: DIGEST_SYSTEM,
    user,
    text: call.kind === 'ok' ? JSON.stringify(call.value) : null,
    errorDetail: call.kind === 'error' ? call.detail : null,
    ok: call.kind === 'ok',
    code: call.kind === 'error' ? call.code : null,
    elapsedMs: call.cost.elapsedMs,
    costUsd: call.cost.costUsd,
  });
  const budget = charge(input.budget, call.cost.costUsd, Date.now() - input.startedAt);
  const taskCosts = chargeTask(input.taskCosts, 'digest', call.cost.costUsd);

  if (call.kind === 'error') {
    // 你按了取消、請求被中斷 —— **這一份沒讀完**，什麼都不寫，留在「還沒讀」。
    if (ctx.state.cancelled) return { budget, taskCosts, code: null, interrupted: true };
    return failWith(call.code, budget, taskCosts);
  }

  const digest = normalizeDigest(call.value);
  // 形狀對不上（`relevance` 不是三個值之一、標題與摘要都空）：**整份不採用** ——
  // 一個猜出來的「有關」會變成確認畫面上「進圖」的預設值（`digest.ts` 檔頭）。
  if (digest === null) return failWith('PROVIDER_OUTPUT_SCHEMA_MISMATCH', budget, taskCosts);

  const now = Date.now();
  // 兩列一起寫：判斷在候選上、繁中在資料上（v11）。分兩次的話中間那一刻畫面會讀到「有判斷、沒有繁中」。
  withTransaction(db, () => {
    setItemDigest(db, {
      id: itemId,
      titleZh: digest.titleZh,
      summaryZh: digest.summaryZh,
      digestedBy: input.chat.name,
      now,
    });
    research.setCandidateDigest(db, {
      id: candidate.id,
      relevance: digest.relevance,
      why: digest.why,
      code: null,
      now,
    });
  });
  ctx.state.channel.emit({
    type: 'digest',
    candidateId: candidate.id,
    itemId,
    relevance: digest.relevance,
    code: null,
  });
  return { budget, taskCosts, code: null, interrupted: false };
}

// ── 你這一邊的動作 ──────────────────────────────────────────

async function withResearch(
  dataRoot: string,
  slug: string,
  researchId: string,
  load: ProvidersLoader,
  body: (
    db: DatabaseSync,
    row: research.ResearchRow,
    cid: string,
  ) => Promise<Result<unknown> | null>,
): Promise<Result<ResearchView>> {
  const cid = correlationId();
  const db = await openResearchCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    const row = research.getResearch(db, researchId);
    if (row === null) return err('RESEARCH_NOT_FOUND', cid, { researchId });
    const failed = await body(db, row, cid);
    if (failed !== null && !failed.ok) return failed;
    const after = research.getResearch(db, researchId);
    if (after === null) return err('RESEARCH_UNEXPECTED', cid, { researchId });
    return ok(await viewOf(db, after, await load(), caseFolderOf(dataRoot, slug)), cid);
  } finally {
    db.close();
  }
}

function liveOf(row: research.ResearchRow): boolean {
  return row.collectRunId !== null && registry.isActive(row.collectRunId);
}

/** 一列候選，而且它屬於這一次研究、這個動作現在按得下去。 */
function candidateFor(
  db: DatabaseSync,
  row: research.ResearchRow,
  candidateId: string,
  action: CandidateAction,
  cid: string,
): research.ResearchCandidateRow | Result<never> {
  const candidate = research.getCandidate(db, candidateId);
  if (candidate === null || candidate.researchId !== row.id) {
    return err('RESEARCH_CANDIDATE_NOT_FOUND', cid, { candidateId });
  }
  if (!mayActOnCandidate(action, row.status, candidate.acquisition, liveOf(row))) {
    return err('RESEARCH_STEP_INVALID', cid, {
      status: row.status,
      acquisition: candidate.acquisition,
      want: action,
    });
  }
  return candidate;
}

/**
 * 把你自己拿到的檔案對回一列候選（R10，Q8：逐列上傳）。
 *
 * **走一般的匯入**（一筆 `kind='import'` 的作業，D3）—— 快照、抽取、索引只有一份實作。
 * 出處指得回那一列的網址：它寫進這一份的 `requested_url`（`importFileInto` 的檔頭）。
 * 檔案進不去（型別不支援、抽不出東西）的話**那一列不動**，回那一份的錯誤碼。
 */
export async function uploadCandidate(
  dataRoot: string,
  slug: string,
  researchId: string,
  candidateId: string,
  file: { readonly name: string; readonly bytes: Uint8Array },
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  return withResearch(dataRoot, slug, researchId, load, async (db, row, cid) => {
    const candidate = candidateFor(db, row, candidateId, 'upload', cid);
    if ('ok' in candidate) return candidate;
    if (readCase(db)?.status === 'archived') return err('CASE_ARCHIVED', cid, { slug });

    const imported = await importFileInto(db, caseFolderOf(dataRoot, slug), {
      fileName: file.name,
      bytes: file.bytes,
      correlationId: cid,
      forUrl: candidate.url,
      researchId,
    });
    if (imported.failed || imported.itemId === null) {
      return err((imported.code ?? 'PARSE_UNEXPECTED') as ErrorCode, cid, {
        candidateId,
        runId: imported.runId,
      });
    }
    research.setAcquisition(db, {
      id: candidateId,
      acquisition: 'uploaded',
      code: imported.code,
      itemId: imported.itemId,
      now: Date.now(),
    });

    /**
     * **上傳之後自動讀這一份**（R14）：開一筆只讀、不搜不抓的作業（`only: 'digest'`）——
     * 順手重試一條失敗的搜尋會花 Claude Code 的額度，而你按的是「上傳」。
     * 已經有一筆在跑的話不另外開：它讀完一輪會再查一次（`processCollect` 的 ③）。
     *
     * 初讀配不上（閘門一之後設定被改掉了）的話**上傳照樣成功**：那一份留在「還沒讀」，
     * 「繼續蒐集」按下去的時候會說是哪一個任務沒設定。
     */
    if (!liveOf(row)) {
      const providers = await load();
      const digest = await checkDigest(providers, cid);
      if (digest.ok) {
        if (row.status === 'awaiting-user') {
          research.moveResearchIf(db, researchId, 'awaiting-user', 'collecting', Date.now());
        }
        await launchCollect(db, {
          dataRoot,
          slug,
          researchId,
          providers,
          agent: null,
          digest: digest.data,
          only: 'digest',
          correlationId: cid,
        });
      }
    }
    return null;
  });
}

/** 你說拿不到，而且說了原因（R11）。 */
export async function markCandidateUnavailable(
  dataRoot: string,
  slug: string,
  researchId: string,
  candidateId: string,
  input: { readonly reason: unknown; readonly note?: unknown },
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  return withResearch(dataRoot, slug, researchId, load, async (db, row, cid) => {
    const reason = unavailableReasonOf(input.reason);
    if (reason === null) return err('RESEARCH_STEP_INVALID', cid, { want: 'unavailable-reason' });
    const candidate = candidateFor(db, row, candidateId, 'unavailable', cid);
    if ('ok' in candidate) return candidate;
    const note = typeof input.note === 'string' ? input.note.replace(/\s+/g, ' ').trim() : '';
    research.markUnavailable(db, {
      id: candidateId,
      reason,
      // 「其他」那一句是你寫的，**原樣留著**（只收掉多餘的空白、切到一個畫面放得下的長度）。
      note: note.slice(0, 200),
      now: Date.now(),
    });
    return null;
  });
}

/** 標錯了 —— 改回「要你拿」。**抓過的錯誤碼還在**（`markUnavailable` 沒有清它）。 */
export async function reopenCandidate(
  dataRoot: string,
  slug: string,
  researchId: string,
  candidateId: string,
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  return withResearch(dataRoot, slug, researchId, load, async (db, row, cid) => {
    const candidate = candidateFor(db, row, candidateId, 'reopen', cid);
    if ('ok' in candidate) return candidate;
    research.setAcquisition(db, {
      id: candidateId,
      acquisition: 'needs-user',
      code: candidate.code,
      now: Date.now(),
    });
    return null;
  });
}

/**
 * 「繼續蒐集」（R13）：開一筆**新的**作業，只做還沒做完的 —— 已抓的不重抓。
 *
 * 只剩要抓的時候**不檢查找來源的服務**：那一段不會呼叫它，為了一個不會發生的呼叫擋住你沒有道理。
 */
export async function resumeCollecting(
  dataRoot: string,
  slug: string,
  researchId: string,
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  return withResearch(dataRoot, slug, researchId, load, async (db, row, cid) => {
    const work = collectWork(
      research.listDirections(db, researchId),
      research.listCandidates(db, researchId),
    );
    if (!mayResumeCollecting(row.status, liveOf(row), work)) {
      return err('RESEARCH_STEP_INVALID', cid, { status: row.status, want: 'resume' });
    }
    const providers = await load();
    let agent: AgentProvider | null = null;
    if (work.searches > 0) {
      const checked = await checkFindSources(providers, cid);
      if (!checked.ok) return checked;
      agent = checked.data;
    }
    // **初讀每一次都檢查**：這一筆要讀的不只是上一次沒讀完的，還有這一筆新抓到的。
    const digest = await checkDigest(providers, cid);
    if (!digest.ok) return digest;
    if (row.status === 'awaiting-user') {
      research.moveResearchIf(db, researchId, 'awaiting-user', 'collecting', Date.now());
    }
    await launchCollect(db, {
      dataRoot,
      slug,
      researchId,
      providers,
      agent,
      digest: digest.data,
      correlationId: cid,
    });
    return null;
  });
}

/**
 * 閘門二「完成蒐集」（R12）：**按下去之後不再找、不再抓新的**。
 *
 * 還有「要你拿」的也按得下去 —— 那幾列在確認那一步的預設是「只留書目」（ADR-0033 D10）。
 * 這一版停在「確認中」：確認與建圖在 Stage 22，畫面照實說。
 */
export async function finishCollecting(
  dataRoot: string,
  slug: string,
  researchId: string,
  load: ProvidersLoader = loadProviders,
): Promise<Result<ResearchView>> {
  return withResearch(dataRoot, slug, researchId, load, async (db, row, cid) => {
    if (!mayFinishCollecting(row.status, liveOf(row))) {
      return err('RESEARCH_STEP_INVALID', cid, { status: row.status, want: 'finish-collecting' });
    }
    const now = Date.now();
    research.resetFetching(db, researchId, now);
    if (!research.moveResearchIf(db, researchId, row.status, 'reviewing', now)) {
      return err('RESEARCH_STEP_INVALID', cid, { status: row.status, want: 'finish-collecting' });
    }
    return null;
  });
}
