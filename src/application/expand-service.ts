/**
 * LLM 擴展的用例編排 —— **Stage 9。**
 *
 * ## 兩階段，中間有一個人
 *
 * ```
 * POST /runs            → 產生切入角度（**還沒開始抓**）
 *          ↓  使用者勾選
 * POST /runs/:id/angles → 這一步才真的開始
 * ```
 *
 * 那個中間點是 REQ-0004 的驗收條件（「不是黑箱一次跑完」），**不是 UI 糖**。
 * 一次跑完的版本少寫一支端點、少一個畫面，而且完全可行 ——
 * 它只是把這個工具變成它想取代的那種東西。
 *
 * ## 這一階段是機器第一次寫進圖裡，所以四條規則在這裡第一次真的被走到
 *
 * | 規則 | 在哪裡執行 |
 * |---|---|
 * | 機器永遠不得覆寫人工判定 | `applyProposal`（Stage 8 就寫好了，這裡是第一個呼叫端）|
 * | 已否決是墓碑 | 同上 —— `blocked-by-tombstone` 什麼都不寫 |
 * | 每條關聯都帶出處 | `locateQuote`：**引文在正文裡找不到就沒有這條邊** |
 * | agent 找到的東西不能自己抓 | `--tools WebSearch` ＋ 事後掃沙箱 |
 *
 * ## 一條角度失敗不影響其餘
 *
 * `部分失敗` 是一等公民。每條角度有自己的錯誤碼（`run_angle.code`），
 * 每個網址有自己的（`run_item.code`）。
 * **唯一會讓整批停下來的是 `error` 級的碼** —— 目前只有沙箱違規，
 * 而那代表 agent 在做我們明文禁止的事，繼續跑才是錯的。
 */
import { mkdir, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { levelOf, type ErrorCode } from '../domain/errors/codes.js';
import { scoreFor } from '../domain/graph/index.js';
import {
  angleOutcome,
  settleAngles,
  type AngleOutcome,
  type RunStatus,
} from '../domain/ingest/state.js';
import { DEFAULT_INTERVAL_MS } from '../domain/ingest/throttle.js';
import { displayHost } from '../domain/ingest/url.js';
import {
  DEFAULT_BUDGET,
  EMPTY_BUDGET_STATE,
  MAX_SELECTED_ANGLES,
  charge,
  locateQuote,
  mayContinue,
  missingFor,
  normalizeAngles,
  normalizeCandidates,
  normalizeExtraction,
  sandboxViolations,
  TASK_ANGLES,
  TASK_EXTRACT,
  TASK_FIND_SOURCES,
  type BudgetState,
  type CapabilityFlag,
} from '../domain/provider/index.js';
import {
  openCaseDatabase,
  withTransaction,
  type DatabaseSync,
} from '../infrastructure/db/database.js';
import { readCase, updateCaseStatus } from '../infrastructure/db/repositories/case-repo.js';
import * as entities from '../infrastructure/db/repositories/entity-repo.js';
import { applyProposal } from '../infrastructure/db/repositories/edge-repo.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as runs from '../infrastructure/db/repositories/run-repo.js';
import { reindexTitleRank } from '../infrastructure/index/writer.js';
import { readDerived } from '../infrastructure/fs/case-files.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { Crawler } from '../infrastructure/fetch/crawler.js';
import { loadProviders, type Providers } from '../infrastructure/providers/registry.js';
import type { ChatProvider } from '../infrastructure/providers/types.js';
import { correlationId, newId } from '../shared/id.js';
import { logger } from '../shared/log.js';
import { err, ok, type Result } from '../shared/result.js';
import {
  ANGLES_SCHEMA,
  ANGLES_SYSTEM,
  anglesUser,
  EXTRACT_SCHEMA,
  EXTRACT_SYSTEM,
  extractUser,
  SOURCES_SCHEMA,
  SOURCES_SYSTEM,
  sourcesUser,
} from './expansion-prompts.js';
import { processOneUrl, type OneOutcome } from './ingest-service.js';
import * as registry from './run-registry.js';

const CASE_DB_FILE = 'case.sqlite';

/** 給模型看的既有內容取幾份。**最近的優先** —— 專題是往前長的。 */
const SEED_LIMIT = 12;
const SEED_EXCERPT_CHARS = 120;

/** 共同提及邊的關係型別與可信度，跟合成資料用的是同一組。 */
const MENTION_REL = '提到';
const MENTION_CONFIDENCE = 0.9;

/** provider 載入方式可以換 —— **測試用一個假的 CLI 與一個假的 Ollama**，其餘完全走真實路徑。 */
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

function caseFolderOf(dataRoot: string, slug: string): string {
  return join(casesDir(dataRoot), slug);
}

/** `<資料根>\cases\<專題>\agent\runs\<run-id>\<第幾條角度>\`（storage-layout）。 */
function sandboxOf(dataRoot: string, slug: string, runId: string, ord: number): string {
  return join(caseFolderOf(dataRoot, slug), 'agent', 'runs', runId, String(ord));
}

// ── 對外的形狀 ──────────────────────────────────────────────

export interface AngleSeed {
  readonly id: string;
  readonly title: string;
}

export interface AngleView {
  readonly id: string;
  readonly ord: number;
  readonly question: string;
  readonly stance: string;
  /**
   * 這條角度是從既有的哪幾份長出來的。
   *
   * **設計稿在這裡寫的是「預估會找到幾個」** —— 那個數字只可能是模型猜的，
   * 而它會以一個精確的樣子出現在一個要人做決定的畫面上。
   * 這一欄是我們查得到也驗得了的，而且對「要不要勾」更有用。
   */
  readonly seeds: readonly AngleSeed[];
  readonly selected: boolean;
  readonly foundUrls: number;
  readonly newNodes: number;
  readonly newEdges: number;
  readonly code: string | null;
}

export interface ExpansionStart {
  readonly runId: string;
  readonly topic: string;
  readonly angles: readonly AngleView[];
  /** 有幾份既有內容被拿去歸納視角。**0 代表這個專題是空的**，畫面上要說 */
  readonly seededFrom: number;
}

/** 作業紀錄那一頁也要用它，所以它是 export 的。 */
export function viewAngles(db: DatabaseSync, runId: string): readonly AngleView[] {
  const rows = runs.listAngles(db, runId);
  const ids = [...new Set(rows.flatMap((r) => r.seeds))];
  const titles = new Map(items.loadItems(db, ids).map((i) => [i.id, i.title]));
  return rows.map((row) => ({
    id: row.id,
    ord: row.ord,
    question: row.question,
    stance: row.stance,
    seeds: row.seeds
      .filter((id) => titles.has(id))
      .map((id) => ({ id, title: titles.get(id) as string })),
    selected: row.selected,
    foundUrls: row.foundUrls,
    newNodes: row.newNodes,
    newEdges: row.newEdges,
    code: row.code,
  }));
}

// ── 配對 ────────────────────────────────────────────────────

/**
 * 「這個任務需要 X，目前設定的 provider 沒有 X」（ADR-0006 第 3 條）。
 *
 * **缺哪幾樣要帶到畫面上**，所以它進 `detail`。
 * 只回一個 `PROVIDER_CAPABILITY_MISSING` 而不說缺什麼，
 * 使用者就不知道要去改什麼 —— 那跟自動降級一樣沒用，只是失敗得比較大聲。
 */
function capabilityError(
  cid: string,
  role: 'agent' | 'chat',
  flags: readonly CapabilityFlag[],
  /**
   * context 不夠時的 `[需要, 宣告有的]`。
   *
   * **這一欄 2026-09-09 才補上，而在那之前它被丟掉了。** `missingFor` 早就會回
   * 「旗標都在、只是 context 不夠」這種結果（`flags` 是空陣列、`context` 有值），
   * 而呼叫端只帶 `match.flags` 出去 —— 於是畫面上顯示的是
   * **「缺少：（空白）」**。那比不報錯還糟：它說了有問題，卻沒說是什麼問題。
   */
  context: readonly [number, number] | null = null,
): Result<never> {
  return err('PROVIDER_CAPABILITY_MISSING', cid, {
    role,
    missing: flags,
    ...(context === null ? {} : { needContextTokens: context[0], haveContextTokens: context[1] }),
  });
}

// ── 第一階段：產生切入角度 ──────────────────────────────────

/**
 * 開一次擴展。**回傳的是子問題清單，還沒有開始抓任何東西。**
 *
 * 這一步花掉一次模型呼叫，而那一次是記在帳上的（`run.requests`）——
 * 使用者最後沒有勾任何一條的話，這次作業仍然花了那一次。
 * **那不是浪費，那是這次作業真的發生過的事。**
 */
export async function startExpansion(
  dataRoot: string,
  slug: string,
  topic: string,
  load: ProvidersLoader = loadProviders,
): Promise<Result<ExpansionStart>> {
  const cid = correlationId();
  const trimmed = topic.trim();
  if (trimmed.length === 0) return err('SEARCH_QUERY_EMPTY', cid, { why: 'no-topic' });

  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });

  try {
    const caseRow = readCase(db);
    if (caseRow === null) return err('CASE_NOT_FOUND', cid, { slug });
    if (caseRow.status === 'archived') return err('CASE_ARCHIVED', cid, { slug });

    const providers = await load();
    // **`chatFor` 不是 `chat`。** 後者是預設模型那一支，而歸納角度可以被覆寫到
    // 另一個模型上（`CHAT_TASKS`）—— 用錯的話覆寫會被安靜地繞過去。
    const chat: ChatProvider | null = providers.chatFor('angles');
    if (chat === null) return err('PROVIDER_NOT_CONFIGURED', cid, { role: 'chat' });

    const probe = await chat.probe();
    if (probe.kind === 'not-configured')
      return err('PROVIDER_NOT_CONFIGURED', cid, { role: 'chat' });
    if (probe.kind === 'unreachable')
      return err('PROVIDER_UNREACHABLE', cid, { role: 'chat', at: probe.detail });

    const match = missingFor(TASK_ANGLES, probe.capabilities);
    if (match.kind === 'missing') return capabilityError(cid, 'chat', match.flags, match.context);

    /**
     * **視角是從既有的東西歸納出來的**（STORM，`market-scan.md` 發現 ⑥）。
     *
     * **只取 `included` 的** —— 抓失敗的那些「有」的只是一個網址：
     * 它們的 `title` 就是那個 URL，正文一個字都沒有。
     *
     * 拿它們當素材有兩個壞處，而兩個都是在真的跑過一次之後才看得到的：
     * 模型拿到的是一串沒有內容的網址（**歸納不出任何角度**），
     * 而畫面上會寫「依據：https://…」—— 指著一份使用者根本讀不到的東西。
     *
     * 2026-09-08 第一次真的跑完一次擴展時，6 份裡有 5 份是付費牆
     * （`FETCH_LOGIN_REQUIRED`，工具照規則不繞過），而它們全部被當成了種子。
     */
    const page = items.listItems(db, { sort: 'recent', limit: SEED_LIMIT, status: 'included' });
    const seedRows = page.items;
    const seeds = seedRows.map((row) => ({
      title: row.title,
      excerpt: row.excerpt.slice(0, SEED_EXCERPT_CHARS),
    }));

    const call = await chat.json({
      system: ANGLES_SYSTEM,
      user: anglesUser(trimmed, seeds),
      schema: ANGLES_SCHEMA,
    });

    const runId = newId();
    const now = Date.now();
    runs.insertRun(db, {
      id: runId,
      kind: 'expand',
      label: trimmed,
      // **勾了幾條才是總數**，而那要等使用者勾完。先寫 0。
      total: 0,
      correlationId: cid,
      now,
      topic: trimmed,
      providers: JSON.stringify({
        chat: chat.name,
        /**
         * **抽取可能跑在另一個模型上**（`CHAT_TASKS`），而作業紀錄那一行的
         * 存在理由就是「兩次結果不同時查得出換了模型」—— 只記歸納角度那一個的話，
         * 真正生出關聯的那個模型不在紀錄裡。
         *
         * 相同就寫 `null`：畫面把 `null` 濾掉，而「A ＋ A」讀起來像兩個東西。
         */
        chatExtract:
          providers.chatFor('extract')?.name === chat.name
            ? null
            : (providers.chatFor('extract')?.name ?? null),
        agent: providers.config.agent?.command ?? null,
      }),
    });
    const spent = charge(EMPTY_BUDGET_STATE, call.cost.costUsd, call.cost.elapsedMs);
    runs.updateRunBudget(db, runId, spent.requests, spent.costUsd);

    if (call.kind === 'error') {
      runs.settleRunRow(db, {
        id: runId,
        status: 'failed',
        succeeded: 0,
        failed: 0,
        errorCode: call.code,
        now: Date.now(),
      });
      return err(call.code, cid, { runId, detail: call.detail });
    }

    const raw = (call.value as { angles?: unknown } | null)?.angles;
    const drafts = normalizeAngles(raw, seedRows.length);
    if (drafts.length === 0) {
      runs.settleRunRow(db, {
        id: runId,
        status: 'failed',
        succeeded: 0,
        failed: 0,
        errorCode: 'PROVIDER_OUTPUT_UNPARSEABLE',
        now: Date.now(),
      });
      return err('PROVIDER_OUTPUT_UNPARSEABLE', cid, { runId, why: 'no-angles' });
    }

    drafts.forEach((draft, i) => {
      runs.insertAngle(db, {
        id: newId(),
        runId,
        ord: i,
        question: draft.question,
        stance: draft.stance,
        // 模型回的是編號，**我們存的是 id** —— 編號只在那一次呼叫裡有意義
        seeds: draft.seeds.map((n) => (seedRows[n] as items.ItemRow).id),
        now,
      });
    });

    return ok(
      { runId, topic: trimmed, angles: viewAngles(db, runId), seededFrom: seedRows.length },
      cid,
    );
  } finally {
    db.close();
  }
}

// ── 第二階段：勾選之後才真的開始 ────────────────────────────

export interface StartedExpansion {
  readonly runId: string;
  readonly total: number;
}

export async function chooseAngles(
  dataRoot: string,
  slug: string,
  runId: string,
  angleIds: readonly string[],
  load: ProvidersLoader = loadProviders,
): Promise<Result<StartedExpansion>> {
  const cid = correlationId();
  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });

  let keepOpen = false;
  try {
    const run = runs.getRun(db, runId);
    if (run === null || run.kind !== 'expand') return err('CASE_NOT_FOUND', cid, { runId });
    // **只有還沒開始的作業可以被勾。** 已經在跑的再勾一次會產生第二批寫入，
    // 而那兩批會共用同一個 run 的計數 —— 作業紀錄從此對不起來。
    if (run.status !== 'queued')
      return err('GRAPH_TRANSITION_INVALID', cid, { runId, status: run.status });

    const known = new Set(runs.listAngles(db, runId).map((a) => a.id));
    const chosen = [...new Set(angleIds)].filter((id) => known.has(id));
    if (chosen.length === 0) return err('EXPORT_EMPTY_SELECTION', cid, { runId, why: 'no-angles' });
    if (chosen.length > MAX_SELECTED_ANGLES)
      return err('PROVIDER_BUDGET_EXCEEDED', cid, { runId, max: MAX_SELECTED_ANGLES });

    const providers = await load();
    const agent = providers.agentFor({
      schema: SOURCES_SCHEMA,
      systemPrompt: SOURCES_SYSTEM,
      maxCostUsd: DEFAULT_BUDGET.maxCostUsd,
    });
    if (agent === null) return err('PROVIDER_NOT_CONFIGURED', cid, { role: 'agent' });

    const probe = await agent.probe();
    if (probe.kind === 'not-configured')
      return err('PROVIDER_NOT_CONFIGURED', cid, { role: 'agent' });
    if (probe.kind === 'unreachable')
      return err('PROVIDER_UNREACHABLE', cid, { role: 'agent', at: probe.detail });
    const match = missingFor(TASK_FIND_SOURCES, probe.capabilities);
    if (match.kind === 'missing') return capabilityError(cid, 'agent', match.flags, match.context);

    // chat 也要在 —— 抽關聯那一步靠它。**在開始之前就檢查**，
    // 不要抓完 30 個網址才發現沒有東西可以抽關聯。
    //
    // **2026-09-09 之前這裡只檢查「有沒有設定」，沒有檢查能力。**
    // 於是一個沒有 `json_schema`、或者 context 只有 8000 的 chat 模型
    // 會一路通過，抓完全部網址，然後在每一份文件上把正文截掉一半 ——
    // 而抽出來的關聯照樣帶引文、照樣進待查證，**畫面上看不出任何異常**。
    // ADR-0006 第 3 條說配不上就停手，而那條規則對一個沒宣告的任務等於不存在。
    const extractChat = providers.chatFor('extract');
    if (extractChat === null) return err('PROVIDER_NOT_CONFIGURED', cid, { role: 'chat' });
    const chatProbe = await extractChat.probe();
    if (chatProbe.kind === 'not-configured')
      return err('PROVIDER_NOT_CONFIGURED', cid, { role: 'chat' });
    if (chatProbe.kind === 'unreachable')
      return err('PROVIDER_UNREACHABLE', cid, { role: 'chat', at: chatProbe.detail });
    const extractMatch = missingFor(TASK_EXTRACT, chatProbe.capabilities);
    if (extractMatch.kind === 'missing')
      return capabilityError(cid, 'chat', extractMatch.flags, extractMatch.context);

    runs.selectAngles(db, runId, chosen);
    runs.updateRunTotal(db, runId, chosen.length);
    if (readCase(db)?.status === 'ready') updateCaseStatus(db, 'collecting', Date.now());

    const state = registry.register(runId);
    keepOpen = true;

    // **不 await。** 這條路徑刻意是「開始了」而不是「做完了」。
    // **不 await，也不在這裡收拾。** `processExpansion` 自己有一個
    // 涵蓋整個函式的 `finally`（登記解除 ＋ 關資料庫）——
    // 在這裡再關一次會是第二次 `close()`，而那會丟例外。
    void processExpansion(db, dataRoot, slug, state, run.topic ?? '', providers).catch(
      (e: unknown) => {
        logger.error('擴展作業意外中止', { correlationId: cid, runId, reason: String(e) });
      },
    );

    return ok({ runId, total: chosen.length }, cid);
  } finally {
    if (!keepOpen) db.close();
  }
}

// ── 背景執行 ────────────────────────────────────────────────

interface AngleTally {
  foundUrls: number;
  newNodes: number;
  newEdges: number;
  code: ErrorCode | null;
}

async function processExpansion(
  db: DatabaseSync,
  dataRoot: string,
  slug: string,
  state: registry.ActiveRun,
  topic: string,
  providers: Providers,
): Promise<void> {
  // **整個函式包在 try 裡。** 這一支是背景執行的，沒有人在 await 它 ——
  // 前置那幾行任何一行丟例外，資料庫連線就會一直開著，
  // 而下一次開同一個專題會撞到鎖。
  try {
    const folder = caseFolderOf(dataRoot, slug);
    const startedAt = Date.now();
    const abort = new AbortController();
    const crawler = new Crawler({
      intervalMs: DEFAULT_INTERVAL_MS,
      onEvent: (e) => state.channel.emit({ type: 'throttled', host: e.host, waitedMs: e.waitedMs }),
    });
    // **取消 ＝ 殺子程序 ＋ 停爬蟲。已寫入的保留。**
    state.cancellable = {
      stop: () => {
        abort.abort();
        crawler.stop();
      },
    };

    const selected = runs.listAngles(db, state.runId).filter((a) => a.selected);
    const before = runs.getRun(db, state.runId);
    let budget: BudgetState = {
      // **第一階段那次呼叫已經記在帳上了**，所以這裡是接著算不是從 0 開始。
      requests: before?.requests ?? 0,
      costUsd: before?.costUsd ?? null,
      elapsedMs: 0,
    };
    /**
     * 每條角度的結局。**三種，不是兩種** ——
     * 一條角度可以「做出了東西，同時有一部分沒做成」（`settleAngles` 的檔頭）。
     */
    const outcomes: AngleOutcome[] = [];
    let fatal: ErrorCode | null = null;

    runs.startRun(db, state.runId, startedAt);
    state.channel.emit({ type: 'started', runId: state.runId, total: selected.length });

    for (const angle of selected) {
      if (state.cancelled) break;
      // **暫停停在角度與角度之間。** 一條角度中途砍掉會留下半套狀態。
      await state.gate();
      if (state.cancelled) break;

      budget = { ...budget, elapsedMs: Date.now() - startedAt };
      const verdict = mayContinue(budget, DEFAULT_BUDGET);
      if (verdict.kind !== 'ok') {
        // **剩下的角度標成超過上限，不是失敗** —— 它們沒有被嘗試過。
        runs.finishAngle(db, {
          id: angle.id,
          foundUrls: 0,
          newNodes: 0,
          newEdges: 0,
          code: 'PROVIDER_BUDGET_EXCEEDED',
        });
        // 它們沒有被嘗試過，所以什麼都沒做出來。
        outcomes.push('failed');
        continue;
      }

      const tally: AngleTally = { foundUrls: 0, newNodes: 0, newEdges: 0, code: null };
      const outcome = await runAngle(db, {
        dataRoot,
        slug,
        folder,
        state,
        topic,
        providers,
        angle,
        crawler,
        abort,
        budget,
        startedAt,
        tally,
      });
      budget = outcome.budget;
      runs.updateRunBudget(db, state.runId, budget.requests, budget.costUsd);
      runs.finishAngle(db, {
        id: angle.id,
        foundUrls: tally.foundUrls,
        newNodes: tally.newNodes,
        newEdges: tally.newEdges,
        code: tally.code,
      });
      state.channel.emit({
        type: 'angle',
        angleId: angle.id,
        question: angle.question,
        foundUrls: tally.foundUrls,
        newNodes: tally.newNodes,
        newEdges: tally.newEdges,
        code: tally.code,
      });

      // **只有 `error` 級的碼會讓整批停下來**（目前只有沙箱違規）。
      const isFatal = tally.code !== null && levelOf(tally.code) === 'error';
      outcomes.push(
        angleOutcome({
          code: tally.code,
          fatal: isFatal,
          produced: tally.foundUrls > 0 || tally.newNodes > 0 || tally.newEdges > 0,
        }),
      );
      if (isFatal) {
        fatal = tally.code;
        break;
      }
    }

    const now = Date.now();
    runs.cancelPendingItems(db, state.runId, now);

    // **「做出了東西」與「一條都沒成」是兩件事，中間那一種是 `部分失敗`。**
    // 這一段第一版把「有碼」一律算成失敗，於是一次寫進 1 個節點與 9 條關聯
    // 的作業被標成「失敗」—— 而畫面上同時列著它寫進去的東西。
    const action = settleAngles(outcomes);
    const status: RunStatus = state.cancelled
      ? 'cancelled'
      : action === 'complete'
        ? 'done'
        : action === 'complete-partial'
          ? 'partial'
          : 'failed';

    // 「成功」＝ 做出了東西的那幾條（含只做成一部分的）；
    // **「失敗」＝ 什麼都沒做出來的那幾條。**
    const succeeded = outcomes.filter((o) => o !== 'failed').length;
    const failed = outcomes.length - succeeded;

    // 取消是誰按的要跟著寫下去 —— 理由與 `ingest-service.ts` 那一處相同。
    runs.settleRunRow(db, {
      id: state.runId,
      status,
      succeeded,
      failed,
      errorCode: fatal,
      endedReason: status === 'cancelled' ? state.cancelReason : null,
      now,
    });
    reindexTitleRank(db);
    if (readCase(db)?.status === 'collecting') updateCaseStatus(db, 'ready', now);
    state.channel.emit({ type: 'settled', status, succeeded, failed });
  } finally {
    registry.unregister(state.runId);
    db.close();
  }
}

interface AngleContext {
  readonly dataRoot: string;
  readonly slug: string;
  readonly folder: string;
  readonly state: registry.ActiveRun;
  readonly topic: string;
  readonly providers: Providers;
  readonly angle: runs.RunAngleRow;
  readonly crawler: Crawler;
  readonly abort: AbortController;
  readonly budget: BudgetState;
  /** 這次作業開始的時間。**牆鐘上限是從它算的** */
  readonly startedAt: number;
  readonly tally: AngleTally;
}

/** 一條角度：找來源 → 掃沙箱 → 走擷取管線 → 抽關聯。 */
async function runAngle(
  db: DatabaseSync,
  ctx: AngleContext,
): Promise<{ readonly budget: BudgetState }> {
  const { angle, tally } = ctx;
  let budget = ctx.budget;

  const sandbox = sandboxOf(ctx.dataRoot, ctx.slug, ctx.state.runId, angle.ord);
  await mkdir(sandbox, { recursive: true });

  const agent = ctx.providers.agentFor({
    schema: SOURCES_SCHEMA,
    systemPrompt: SOURCES_SYSTEM,
    maxCostUsd: DEFAULT_BUDGET.maxCostUsd,
  });
  if (agent === null) {
    tally.code = 'PROVIDER_NOT_CONFIGURED';
    return { budget };
  }

  const call = await agent.run(
    {
      prompt: sourcesUser(ctx.topic, angle.question),
      cwd: sandbox,
      // 子程序的逾時 ＝ 這次作業還剩多久。**不是一個獨立的數字** ——
      // 兩個各自的逾時加起來會超過牆鐘上限。
      timeoutMs: Math.max(1000, ctx.startedAt + DEFAULT_BUDGET.timeoutMs - Date.now()),
    },
    ctx.abort.signal,
  );
  budget = charge(budget, call.cost.costUsd, Date.now() - ctx.startedAt);

  // **沙箱一定要掃，成功失敗都掃。**
  // 只在成功時掃的話，一個「抓了一堆東西然後才失敗」的子程序就查不到了 ——
  // 而那正是最該被查到的情況。
  const violations = sandboxViolations(await listSandbox(sandbox));
  if (violations.length > 0) {
    logger.error('agent 沙箱裡出現了抓取產物', {
      runId: ctx.state.runId,
      angle: angle.ord,
      count: violations.length,
    });
    tally.code = 'PROVIDER_SANDBOX_VIOLATION';
    return { budget };
  }

  if (call.kind === 'error') {
    tally.code = call.code;
    return { budget };
  }

  let candidatesRaw: unknown;
  try {
    candidatesRaw = (JSON.parse(call.value) as { candidates?: unknown }).candidates;
  } catch {
    tally.code = 'PROVIDER_OUTPUT_UNPARSEABLE';
    return { budget };
  }
  const candidates = normalizeCandidates(candidatesRaw);
  tally.foundUrls = candidates.length;
  if (candidates.length === 0) return { budget };

  for (const candidate of candidates) {
    if (ctx.state.cancelled || ctx.crawler.isStopped) break;

    const runItemId = newId();
    runs.insertRunItem(db, {
      id: runItemId,
      runId: ctx.state.runId,
      requested: candidate.url,
      host: displayHost(candidate.url) || null,
    });

    // **同一條擷取管線。** agent 只給了網址，抓是我們抓的 ——
    // 節流、robots、快照、manifest 全部在那一支裡面。
    const outcome: OneOutcome = await processOneUrl(db, ctx.folder, ctx.crawler, ctx.state.runId, {
      id: runItemId,
      url: candidate.url,
    });
    ctx.state.channel.emit({
      type: 'item',
      runItemId,
      requested: candidate.url,
      host: displayHost(candidate.url) || null,
      outcome: outcome.outcome,
      code: outcome.code,
      itemId: outcome.itemId,
    });
    if (outcome.counts === 'ok') tally.newNodes++;
    if (outcome.itemId === null || outcome.counts === 'failed') continue;

    budget = { ...budget, elapsedMs: Date.now() - ctx.startedAt };
    if (mayContinue(budget, DEFAULT_BUDGET).kind !== 'ok') {
      tally.code = 'PROVIDER_BUDGET_EXCEEDED';
      break;
    }

    const extracted = await extractInto(db, {
      folder: ctx.folder,
      // **抽取用抽取那一支。** 上面的閘門檢查的也是它 ——
      // 檢查一支、跑另一支的話，那個閘門就只是裝飾。
      chat: ctx.providers.chatFor('extract') as ChatProvider,
      itemId: outcome.itemId,
      runId: ctx.state.runId,
      abort: ctx.abort,
    });
    budget = charge(budget, extracted.costUsd, budget.elapsedMs);
    tally.newEdges += extracted.newEdges;
    if (extracted.code !== null) tally.code = extracted.code;
    runs.setRunItemEdges(db, runItemId, extracted.newEdges);
  }

  return { budget };
}

/** 沙箱裡有哪些檔案（含子目錄，回相對路徑）。 */
async function listSandbox(root: string): Promise<readonly string[]> {
  try {
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    return entries.filter((e) => e.isFile()).map((e) => relative(root, join(e.parentPath, e.name)));
  } catch {
    return [];
  }
}

interface ExtractContext {
  readonly folder: string;
  readonly chat: ChatProvider;
  readonly itemId: string;
  readonly runId: string;
  readonly abort: AbortController;
}

interface ExtractResult {
  readonly newEdges: number;
  readonly costUsd: number | null;
  readonly code: ErrorCode | null;
}

/**
 * 從一份剛抓回來的內容抽實體與關係，寫進圖裡。
 *
 * ## 引文的位置是我們自己找的
 *
 * 模型回的是引文字串，**不是位置** —— 就算它回了位置我們也不用
 * （`locateQuote` 的檔頭寫了為什麼）。找不到就沒有這條邊：
 * **一個指不到原文的出處，比沒有出處更糟。**
 *
 * ## 寫入包在一個交易裡
 *
 * 一份文件抽出來的東西是一組：實體、共同提及邊、具名關係與它們的出處。
 * 中途斷掉會留下**有實體、沒有邊**或**有邊、沒有出處**的半套狀態，
 * 而後者正好是「一條看起來可以被確認、但沒有東西支撐它」的邊。
 */
async function extractInto(db: DatabaseSync, ctx: ExtractContext): Promise<ExtractResult> {
  const derived = await readDerived(ctx.folder, ctx.itemId);
  if (derived === null || derived.text.trim().length === 0) {
    return { newEdges: 0, costUsd: null, code: 'PARSE_EMPTY_CONTENT' };
  }

  const call = await ctx.chat.json(
    {
      system: EXTRACT_SYSTEM,
      user: extractUser(derived.title, derived.text),
      schema: EXTRACT_SCHEMA,
    },
    ctx.abort.signal,
  );
  if (call.kind === 'error') {
    return { newEdges: 0, costUsd: call.cost.costUsd, code: call.code };
  }

  const extraction = normalizeExtraction(call.value);
  if (extraction.entities.length === 0) {
    return { newEdges: 0, costUsd: call.cost.costUsd, code: null };
  }

  let quoteMisses = 0;
  const newEdges = withTransaction(db, () => {
    const now = Date.now();
    // **本名、別名、括號裡的都算**（Stage 10.5）。
    //
    // 之前這裡只認一模一樣的寫法，於是「TSMC」與「台灣積體電路製造（TSMC）」
    // 是兩個實體 —— 而投影門檻是「被 ≥3 份提到才畫」，
    // **兩個都低於門檻，所以圖上一個都不會出現**。
    // 那不是「多一個節點」，那是少了唯一那一個。
    let known = entities.listEntities(db);
    const idOf = new Map<string, string>();
    for (const draft of extraction.entities) {
      const found = entities.findEntityFor(known, draft.name, draft.type);
      if (found !== null) {
        idOf.set(draft.name, found.id);
        // **記下這個新的寫法。** 下一份文件用同一種寫法時就直接對得上，
        // 而使用者也看得到「這個實體在你的資料裡有幾種叫法」。
        entities.addAlias(db, found.id, draft.name, now);
        continue;
      }
      const id = newId();
      entities.insertEntity(db, { id, type: draft.type, name: draft.name, now });
      // 同一次抽取裡的第二個寫法要對得到剛剛建的那一個，所以清單要跟著長。
      known = [...known, { id, name: draft.name, type: draft.type, aliases: [], mergedInto: null }];
      idOf.set(draft.name, id);
    }

    let written = 0;

    // 共同提及：**這一份提到這個實體**。不要出處、不進裁決佇列（Q6）。
    for (const draft of extraction.entities) {
      const entityId = idOf.get(draft.name);
      if (entityId === undefined) continue;
      const result = applyProposal(
        db,
        {
          source: ctx.itemId,
          target: entityId,
          rel: MENTION_REL,
          layer: 'comention',
          sourceKind: 'item',
          targetKind: 'entity',
          confidence: MENTION_CONFIDENCE,
          evidence: [],
          runId: ctx.runId,
        },
        now,
      );
      if (result.kind === 'created') written++;
    }

    // 具名關係：**一定要有一句在原文裡找得到的引文。**
    for (const relation of extraction.relations) {
      const source = idOf.get(relation.subject);
      const target = idOf.get(relation.object);
      if (source === undefined || target === undefined) continue;

      const at = locateQuote(derived.text, relation.quote);
      if (at.kind !== 'found') {
        quoteMisses++;
        continue;
      }

      const result = applyProposal(
        db,
        {
          source,
          target,
          rel: relation.rel,
          layer: 'named',
          sourceKind: 'entity',
          targetKind: 'entity',
          // **分數是數出來的，不是模型給的**（`scoreFor` 的檔頭）。
          // 剛抽出來的一條 ＝ 1 個獨立來源 ＋ 有直接引文。
          confidence: scoreFor({ independentSourceCount: 1, hasDirectQuote: true }),
          evidence: [
            {
              itemId: ctx.itemId,
              quote: derived.text.slice(at.start, at.end),
              charStart: at.start,
              charEnd: at.end,
            },
          ],
          runId: ctx.runId,
        },
        now,
      );
      if (result.kind === 'created' || result.kind === 'revived') written++;
    }
    return written;
  });

  return {
    newEdges,
    costUsd: call.cost.costUsd,
    // **引文找不到要說出來**，不是安靜地少幾條邊。
    code: quoteMisses > 0 ? 'PROVIDER_QUOTE_NOT_FOUND' : null,
  };
}

// ── 讀 ──────────────────────────────────────────────────────

export async function listAngles(
  dataRoot: string,
  slug: string,
  runId: string,
): Promise<Result<readonly AngleView[]>> {
  const cid = correlationId();
  const db = await openCase(dataRoot, slug);
  if (typeof db === 'string') return err(db, cid, { slug });
  try {
    if (runs.getRun(db, runId) === null) return err('CASE_NOT_FOUND', cid, { runId });
    return ok(viewAngles(db, runId), cid);
  } finally {
    db.close();
  }
}
