/**
 * 一次研究在畫面上長什麼樣子（ADR-0033、REQ-0009）。
 *
 * **規劃（`research-service.ts`）與蒐集（`research-collect.ts`）回的是同一份** ——
 * 每一個會改狀態的動作都回整份畫面，而不是「成功了，請再讀一次」：
 * 後者在兩次請求之間留一個空隙，畫面會閃一下舊的狀態。
 *
 * ## 這一支只讀
 *
 * 唯一的例外是打開專題時的孤兒掃描（`openResearchCase`）：蒐集那一筆作業在程式關掉的時候
 * 可能還標著「執行中」，而研究的畫面要說得出「停在半路」—— 那一列不掃掉的話，
 * 作業紀錄那一頁會永遠寫著它還在跑（`run-sweep.ts` 的檔頭）。
 */
import { join } from 'node:path';

import type { ErrorCode } from '../domain/errors/codes.js';
import type { RunEndedReason, RunStatus } from '../domain/ingest/state.js';
import { displayHost } from '../domain/ingest/url.js';
import {
  normalizeDirection,
  type Bibliography,
  type DirectionDraft,
  type Relevance,
  type TaskCosts,
} from '../domain/provider/index.js';
import {
  collectWork,
  defaultDecision,
  effectiveDecision,
  mayFinishBuilding,
  mayResumeBuilding,
  type Decision,
  type BuildState,
  mayActOnCandidate,
  mayFinishCollecting,
  mayResumeCollecting,
  tallyDirection,
  type Acquisition,
  type CollectWork,
  type DirectionTally,
  type ExpectedAccess,
  type ResearchKind,
  type ResearchStatus,
  type UnavailableReason,
} from '../domain/research/index.js';
import { openCaseDatabase, type DatabaseSync } from '../infrastructure/db/database.js';
import * as items from '../infrastructure/db/repositories/item-repo.js';
import * as research from '../infrastructure/db/repositories/research-repo.js';
import * as runs from '../infrastructure/db/repositories/run-repo.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import type { Providers } from '../infrastructure/providers/registry.js';
import { gapOf, type GapAssessment } from '../domain/research/gap.js';
import type { ConnectionKind } from '../infrastructure/providers/config.js';
import { isActive, isPaused } from './run-registry.js';
import { sweepStaleRuns } from './run-sweep.js';

const CASE_DB_FILE = 'case.sqlite';

export type ProvidersLoader = () => Promise<Providers>;

/**
 * 開一個專題的資料庫給研究用。**這個行程第一次打開它的時候掃一次孤兒作業**（見檔頭）。
 */
export async function openResearchCase(
  dataRoot: string,
  slug: string,
): Promise<DatabaseSync | ErrorCode> {
  const opened = await openCaseDatabase(join(casesDir(dataRoot), slug, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new') return 'CASE_SCHEMA_TOO_NEW';
  if (opened.kind === 'migrate-failed') return 'CASE_SCHEMA_MIGRATE_FAILED';
  if (opened.kind === 'missing') return 'CASE_NOT_FOUND';
  sweepStaleRuns(opened.db, slug);
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
  /** 搜過了沒有（Stage 20）。**搜過、找到 0 份的是 `done`** */
  readonly searchState: 'pending' | 'done' | 'failed';
  readonly searchCode: string | null;
  /** 找到幾份、拿到幾份、要你拿幾份…… **數的，不叫模型說**（ADR-0033 D10）。 */
  readonly tally: DirectionTally;
}

/** 一個候選在畫面上的樣子（Stage 20，ADR-0033 D7）。 */
export interface CandidateView {
  readonly decision: Decision | null;
  readonly defaultDecision: Decision;
  readonly effectiveDecision: Decision;
  readonly citedBy: readonly string[];
  readonly buildState: BuildState | null;
  readonly buildCode: string | null;
  readonly id: string;
  /** 第一條找到它的方向在最前面；別的方向也找到的接在後面 */
  readonly directionIds: readonly string[];
  readonly url: string;
  readonly host: string;
  /** 搜尋結果上的標題。**空的時候畫面退回網址**，不替它編一個 */
  readonly title: string;
  readonly why: string;
  readonly bib: Bibliography;
  readonly expectedAccess: ExpectedAccess;
  /**
   * 取得狀態。**`fetching` 只在作業活著的時候出現** —— 程式停在半路的那幾列讀起來是
   * `found`（還沒抓），不是一個永遠不會結束的「抓取中」。
   */
  readonly acquisition: Acquisition;
  /** 抓不到的那一種（既有的擷取錯誤碼，R9）；抓到了的是通知級的碼（重複、抽取信心低）或 `null` */
  readonly code: string | null;
  /** **依你的紀錄沒去試**（R8）：`needs-user` 而且沒有錯誤碼 */
  readonly skipped: boolean;
  readonly unavailableReason: UnavailableReason | null;
  readonly reasonNote: string;
  readonly itemId: string | null;
  /**
   * 初讀（Stage 21）。`relevance` 是 `null` 而 `digestCode` 也是 `null` ＝ 還沒讀；
   * 有碼 ＝ 讀過但失敗（`PARSE_EMPTY_CONTENT` 以外的，「繼續蒐集」會再讀）。
   */
  readonly relevance: Relevance | null;
  readonly relevanceWhy: string;
  readonly digestCode: string | null;
  /**
   * 那一份資料的繁中標題與摘要（`item.title_zh`／`summary_zh`）。**衍生物，原文是上面的 `title`** ——
   * 畫面兩個都顯示，而且說得出是誰、什麼時候產生的（`digestedBy`／`digestedAt`，R15）。
   */
  readonly titleZh: string | null;
  readonly summaryZh: string | null;
  readonly digestedBy: string | null;
  readonly digestedAt: number | null;
  /** 這一列上現在按得下去的動作（`mayActOnCandidate`）。**畫面不自己判斷** */
  readonly actions: {
    readonly upload: boolean;
    readonly unavailable: boolean;
    readonly reopen: boolean;
  };
}

/** 一條服務：誰在做、會不會花錢。**閘門旁邊那句「接下來會花錢嗎」用它**（R5、ADR-0033 D2）。 */
export interface ServiceView {
  readonly via: ConnectionKind;
  readonly model: string;
  /** 會不會花錢：本機不會，Claude Code 與線上端點會。 */
  readonly costs: boolean;
}

/** 規劃對話走哪個服務、會不會上網查。 */
export interface PlanService extends ServiceView {
  /** 這條服務會不會上網查。**本機 Ollama 是 false，而那不是壞掉**（D5）。 */
  readonly browses: boolean;
}

/** 蒐集那一段的即時狀態（Stage 20）。 */
export interface CollectView {
  /** 最新的那一筆蒐集作業。閘門一之前是 `null` */
  readonly runId: string | null;
  /** **執行時的事實**，資料庫看不出來（`run-service.ts` 的 `live` 同一個理由） */
  readonly live: boolean;
  readonly paused: boolean;
  readonly runStatus: RunStatus | null;
  readonly endedReason: RunEndedReason | null;
  /** 整筆作業停下來的原因（例如沙箱違規）。單一方向、單一網址的在各自那一列 */
  readonly errorCode: string | null;
  /** 還有什麼可以做（R13：已抓的不重抓） */
  readonly work: CollectWork;
  readonly mayResume: boolean;
  /** 閘門二按得下去嗎 */
  readonly mayFinish: boolean;
}

export interface ResearchView {
  readonly extractService: ServiceView;
  readonly build: {
    readonly runId: string | null;
    readonly live: boolean;
    readonly done: number;
    readonly total: number;
    readonly mayResume: boolean;
    readonly mayFinish: boolean;
  };
  readonly id: string;
  readonly kind: ResearchKind;
  readonly status: ResearchStatus;
  readonly topic: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 專題裡總共幾份、其中幾份提到這個主題（R1）。 */
  readonly hitTotal: number;
  readonly gap: GapAssessment | null;
  readonly hits: readonly ResearchHit[];
  readonly plan: PlanView;
  readonly messages: readonly MessageView[];
  readonly directions: readonly FrozenDirection[];
  readonly candidates: readonly CandidateView[];
  readonly collect: CollectView;
  /** 到目前為止花了多少；`unknownCost` 是「有幾次沒回報」（R29）—— 對話與作業加起來。 */
  readonly costUsd: number;
  readonly unknownCost: number;
  /**
   * 逐任務的那一份（v11，R29）：規劃對話、找來源、初讀……各自花了多少、幾次沒回報。
   * **沒出現的任務就是還沒跑過**，不是 0。加起來等於上面兩個數字。
   */
  readonly costByTask: TaskCosts;
  readonly service: PlanService;
  /** 找候選來源走哪個服務（閘門一與「繼續蒐集」旁邊那句話）。 */
  readonly findService: ServiceView;
  /** 初讀走哪個服務（Stage 21）：同一句話的後半 ——「拿到的每一份由 {服務} 讀一次」。 */
  readonly digestService: ServiceView;
}

const EMPTY_PLAN_VIEW: PlanView = {
  relation: '',
  directions: [],
  outOfScope: [],
  overflow: false,
};

/** `plan_json` 存的是 `PlanView`。**讀不回來就當空的** —— 壞掉的一欄不該讓整次研究打不開。 */
export function planOf(raw: string): PlanView {
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

export function hitsOf(raw: string): readonly ResearchHit[] {
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

function planServiceOf(providers: Providers): PlanService {
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

function findServiceOf(providers: Providers): ServiceView {
  const setting = providers.config.tasks['find-sources'];
  return { via: setting.via, model: setting.model, costs: setting.via !== 'ollama' };
}

function digestServiceOf(providers: Providers): ServiceView {
  const setting = providers.config.tasks.digest;
  return { via: setting.via, model: setting.model, costs: setting.via !== 'ollama' };
}

function collectOf(
  row: research.ResearchRow,
  run: runs.RunRow | null,
  work: CollectWork,
): CollectView {
  const live = run !== null && isActive(run.id);
  return {
    runId: run?.id ?? null,
    live,
    paused: run !== null && isPaused(run.id),
    runStatus: run?.status ?? null,
    endedReason: run?.endedReason ?? null,
    errorCode: run?.errorCode ?? null,
    work,
    mayResume: mayResumeCollecting(row.status, live, work),
    mayFinish: mayFinishCollecting(row.status, live),
  };
}

export function viewOf(
  db: DatabaseSync,
  row: research.ResearchRow,
  providers: Providers,
): ResearchView {
  const cost = research.costSoFar(db, row.id);
  const run = row.collectRunId === null ? null : runs.getRun(db, row.collectRunId);
  const live = run !== null && isActive(run.id);
  const directions = research.listDirections(db, row.id);
  const candidates = research.listCandidates(db, row.id);
  const buildRun = row.buildRunId === null ? null : runs.getRun(db, row.buildRunId);
  const building = buildRun !== null && isActive(buildRun.id);
  const extractSetting = providers.config.tasks.extract;
  const work = collectWork(directions, candidates);
  // 初讀的繁中住在資料上（v11）。**一次撈完**，不是每一列各查一次。
  const itemsById = new Map(
    items
      .loadItems(
        db,
        candidates.flatMap((c) => (c.itemId === null ? [] : [c.itemId])),
      )
      .map((i) => [i.id, i]),
  );

  const candidateViews: CandidateView[] = candidates.map((c) => {
    // 作業沒有在跑，就沒有東西「正在抓」—— 停在半路的那幾列是還沒抓（見 `CandidateView`）。
    const acquisition: Acquisition =
      c.acquisition === 'fetching' && !live ? 'found' : c.acquisition;
    const item = c.itemId === null ? undefined : itemsById.get(c.itemId);
    return {
      id: c.id,
      decision: c.decision,
      defaultDecision: defaultDecision(c),
      effectiveDecision: effectiveDecision(c),
      citedBy: c.citedBy,
      buildState: c.buildState,
      buildCode: c.buildCode,
      directionIds: [...(c.directionId === null ? [] : [c.directionId]), ...c.alsoDirections],
      url: c.url,
      host: displayHost(c.url),
      title: c.title,
      why: c.why,
      bib: c.bib,
      expectedAccess: c.expectedAccess,
      acquisition,
      code: c.code,
      skipped: acquisition === 'needs-user' && c.code === null,
      unavailableReason: c.unavailableReason,
      reasonNote: c.reasonNote,
      itemId: c.itemId,
      relevance: c.relevance,
      relevanceWhy: c.relevanceWhy,
      digestCode: c.digestCode,
      titleZh: item?.titleZh ?? null,
      summaryZh: item?.summaryZh ?? null,
      digestedBy: item?.digestedBy ?? null,
      digestedAt: item?.digestedAt ?? null,
      actions: {
        upload: mayActOnCandidate('upload', row.status, acquisition, live),
        unavailable: mayActOnCandidate('unavailable', row.status, acquisition, live),
        reopen: mayActOnCandidate('reopen', row.status, acquisition, live),
      },
    };
  });

  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    topic: row.topic ?? '',
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hitTotal: items.countByStatus(db)['included'] ?? 0,
    gap: gapOf(row.gapJson),
    hits: hitsOf(row.hitsJson),
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
    directions: directions.map((d) => ({
      id: d.id,
      title: d.title,
      what: d.what,
      expect: d.expect,
      keywords: d.keywords,
      origin: d.origin,
      adopted: d.adopted,
      searchState: d.searchState,
      searchCode: d.searchCode,
      tally: tallyDirection(
        d.id,
        candidates.map((candidate) => ({
          ...candidate,
          directionIds: [
            ...(candidate.directionId === null ? [] : [candidate.directionId]),
            ...candidate.alsoDirections,
          ],
        })),
      ),
    })),
    candidates: candidateViews,
    collect: collectOf(row, run, work),
    extractService: {
      via: extractSetting.via,
      model: extractSetting.model,
      costs: extractSetting.via !== 'ollama',
    },
    build: {
      runId: row.buildRunId,
      live: building,
      done: candidates.filter((candidate) => candidate.buildState === 'done').length,
      total: candidates.length,
      mayResume: mayResumeBuilding(row.status, building),
      mayFinish: mayFinishBuilding(
        row.status,
        building,
        buildRun?.status === 'cancelled' && buildRun.endedReason === null
          ? 'cancelled'
          : 'interrupted',
      ),
    },
    costUsd: cost.costUsd,
    unknownCost: cost.unknown,
    costByTask: cost.byTask,
    service: planServiceOf(providers),
    findService: findServiceOf(providers),
    digestService: digestServiceOf(providers),
  };
}
