/**
 * 蒐集那一段的規則（Stage 20，ADR-0033 D3／D7、REQ-0009 R7–R13）。
 *
 * ## 三件事在這裡決定，而且都是純函式
 *
 * 1. **一個候選抓之前預期拿不拿得到、要不要去試**（`accessPlan`）—— 依你自己的紀錄，不是模型說的
 * 2. **「繼續蒐集」還有什麼可以做**（`collectWork`）—— 已抓的不重抓（R13）
 * 3. **現在可以按哪幾顆**：上傳、標拿不到、繼續蒐集、完成蒐集（閘門二）
 *
 * 資料表在 `infrastructure/db`，用例編排在 `application/research-collect.ts`。
 */
import type { SiteVerdict } from '../sources/status.js';
import { MAX_DIRECTIONS } from '../provider/plan.js';
import type { ResearchStatus } from './index.js';

/**
 * 一個候選的**取得狀態**（schema v10 的 `research_candidate.acquisition`）。
 *
 * 跟最終狀態（進圖／只留書目／丟掉，Stage 22）是兩件事：這一欄說的是「拿到了沒有」，
 * 那一欄說的是「你要不要它」。
 */
export const ACQUISITIONS = [
  'found',
  'fetching',
  'fetched',
  'needs-user',
  'uploaded',
  'unavailable',
] as const;
export type Acquisition = (typeof ACQUISITIONS)[number];

/**
 * 你說拿不到的原因（R11，四選一）。**`other` 要自己寫一句**，畫面上的輸入框就是為它開的。
 *
 * `not-found` 的完整說法是「找不到這一份（可能是模型編的）」—— 找來源的模型會編網址，
 * 而那是它最常見的一種錯：一個看起來很像真的、點下去 404 的論文頁。
 */
export const UNAVAILABLE_REASONS = ['paywall', 'not-found', 'blocked', 'other'] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/**
 * 抓之前的預期（R7：公開／多半要登入／不知道 —— 多一種「會被擋」）。
 *
 * **這是依你自己的紀錄算的**（來源網站那一頁的判斷），不是模型說的：
 * 模型給的是網址與搜尋結果上的東西，「那個網站讀不讀得到」是我們自己抓過才知道的事。
 */
export const EXPECTED_ACCESS = ['open', 'login', 'blocked', 'unknown'] as const;
export type ExpectedAccess = (typeof EXPECTED_ACCESS)[number];

export interface AccessPlan {
  readonly expected: ExpectedAccess;
  /**
   * **不去試，直接列成「要你拿」**（R8）。
   *
   * 只有兩種：依紀錄要登入、依紀錄會出驗證頁。兩者的共同點是「對方主動擋這個工具」——
   * 再試一次只會多一次被擋，驗證頁還可能因此變得更嚴。robots 不准、要跑 JavaScript、
   * 連不到、被限流**照樣去試**：robots 會改、同一個站的不同頁不一樣、後兩種常常是暫時的，
   * 而試的代價很小（robots 一個網域只問一次）。
   */
  readonly skip: boolean;
}

/**
 * 一個網域抓之前的預期。
 *
 * `verdict` 是來源網站那一頁對這個網域的判斷（`null` ＝ 清單上沒有、也沒抓過）；
 * `usuallyWalled` 是內建清單上「一般而言要登入或要看單篇」的那一欄。
 *
 * **「依你自己的紀錄」才會不去試** —— 只有「一般而言要登入」的話照樣試一次：
 * 使用者可能有機構授權，而那一次的結果會變成紀錄（`historyByHost`），下一次就準了。
 */
export function accessPlan(verdict: SiteVerdict | null, usuallyWalled: boolean): AccessPlan {
  const recorded = verdict !== null && verdict.basis !== 'none';
  if (recorded) {
    switch (verdict.access) {
      case 'open':
        return { expected: 'open', skip: false };
      case 'login':
        return { expected: 'login', skip: true };
      case 'challenged':
        return { expected: 'blocked', skip: true };
      case 'disallowed':
      case 'js-only':
        return { expected: 'blocked', skip: false };
      default:
        break;
    }
  }
  return { expected: usuallyWalled ? 'login' : 'unknown', skip: false };
}

/**
 * **這幾種抓不到的，「繼續蒐集」會再試一次。**
 *
 * 被限流是「這一輪先不碰這個網域」（ADR-0031），不是拿不到；其餘的
 * （要登入、驗證頁、robots、404、連不到）再試一次的結果多半一樣，交給人決定。
 */
const RETRYABLE_FETCH_CODES: readonly string[] = ['FETCH_RATE_LIMITED'];

export function retryableFetch(code: string | null): boolean {
  return code !== null && RETRYABLE_FETCH_CODES.includes(code);
}

// ── 還有什麼可以做（R13）─────────────────────────────────────

export interface DirectionWork {
  readonly adopted: boolean;
  readonly searchState: 'pending' | 'done' | 'failed';
}

export interface CandidateWork {
  readonly acquisition: Acquisition;
  readonly code: string | null;
}

export interface CollectWork {
  /** 還沒搜、或上一次搜失敗的方向。**搜過而找到 0 份的不算** —— 那是做完了 */
  readonly searches: number;
  /** 還沒抓的候選，加上被限流、這一輪沒抓的 */
  readonly fetches: number;
}

/** 候選還要機器去抓嗎。`fetching` 在作業沒有活著的時候就是「停在半路」，當成還沒抓。 */
export function needsFetch(candidate: CandidateWork): boolean {
  if (candidate.acquisition === 'found' || candidate.acquisition === 'fetching') return true;
  return candidate.acquisition === 'needs-user' && retryableFetch(candidate.code);
}

/** 方向還要搜嗎。**沒被採用的不搜**（它們是「模型提過、你刪掉的」那幾條）。 */
export function needsSearch(direction: DirectionWork): boolean {
  return direction.adopted && direction.searchState !== 'done';
}

export function collectWork(
  directions: readonly DirectionWork[],
  candidates: readonly CandidateWork[],
): CollectWork {
  return {
    searches: directions.filter(needsSearch).length,
    fetches: candidates.filter(needsFetch).length,
  };
}

export function hasWork(work: CollectWork): boolean {
  return work.searches > 0 || work.fetches > 0;
}

// ── 現在可以按哪幾顆 ─────────────────────────────────────────

/** 蒐集那一段的兩個狀態（中途停下的仍然是 `collecting`，見 `statusAfterCollectRun`）。 */
function collectingStage(status: ResearchStatus): boolean {
  return status === 'collecting' || status === 'awaiting-user';
}

/**
 * 「繼續蒐集」按得下去嗎。
 *
 * **沒有作業在跑、而且還有事可以做**。兩種情形會用到它：程式關掉的時候蒐集還沒做完
 * （研究停在 `collecting`，R13），以及你按了取消、或某幾條方向的搜尋失敗了（`awaiting-user`）。
 */
export function mayResumeCollecting(
  status: ResearchStatus,
  live: boolean,
  work: CollectWork,
): boolean {
  return collectingStage(status) && !live && hasWork(work);
}

/**
 * 閘門二「完成蒐集」按得下去嗎。
 *
 * **還有「要你拿」的也按得下去** —— 它們在確認那一步的預設是「只留書目」（ADR-0033 D10）。
 * 作業還在跑的時候不行：按下去之後「不再抓新的」，而它正在抓。
 * 停在半路的（`collecting`、沒有作業在跑）也可以直接完成 —— 要你先按「繼續蒐集」才能不要它，
 * 是繞一圈。
 */
export function mayFinishCollecting(status: ResearchStatus, live: boolean): boolean {
  return collectingStage(status) && !live;
}

export type CandidateAction = 'upload' | 'unavailable' | 'reopen';

/**
 * 一列候選上的動作按得下去嗎（R10／R11）。
 *
 * - **上傳**：還沒拿到的那幾種。`found` 只有在沒有作業在跑的時候 —— 作業活著的時候
 *   它隨時可能被機器拿去抓，兩邊同時寫同一列會有一邊的結果被蓋掉
 * - **標拿不到**：同上，但已經拿不到的不必再標一次
 * - **改回要你拿**：只對「拿不到」—— 標錯了要改得回來
 *
 * 抓到了的、你上傳過的都不給：它們已經有一份資料了，換掉那一份是 Stage 22 確認那一步的事。
 */
export function mayActOnCandidate(
  action: CandidateAction,
  status: ResearchStatus,
  acquisition: Acquisition,
  live: boolean,
): boolean {
  if (!collectingStage(status)) return false;
  const idle = acquisition === 'found' || acquisition === 'fetching';
  if (idle && live) return false;
  switch (action) {
    case 'upload':
      return idle || acquisition === 'needs-user' || acquisition === 'unavailable';
    case 'unavailable':
      return idle || acquisition === 'needs-user';
    case 'reopen':
      return acquisition === 'unavailable';
  }
}

/**
 * 蒐集那一筆作業結束之後，研究停在哪。
 *
 * **關掉程式時一起停的（`shutdown`）、上次沒收尾被掃到的（`stale`）留在 `collecting`** ——
 * 下次打開時畫面說「蒐集停在半路」，給一顆「繼續蒐集」（ADR-0033 D3、R13）。
 * 其餘（做完、部分完成、失敗、**你自己按的取消**）都是「機器這邊結束了，輪到你」。
 */
export function statusAfterCollectRun(cancelReason: 'shutdown' | 'stale' | null): ResearchStatus {
  return cancelReason === null ? 'awaiting-user' : 'collecting';
}

// ── 上限 ────────────────────────────────────────────────────

/**
 * 一筆蒐集作業的上限（ADR-0006 的三種）。
 *
 * - **請求數 ＝ 方向數**：每條方向搜一次（`MAX_DIRECTIONS`）。初讀（Stage 21）接上來的時候
 *   這個數字要跟著改 —— 它是「這一次作業最多打幾次模型」，不是「最多搜幾次」
 * - **牆鐘 60 分鐘**：一次搜尋走 Claude Code 常常要一兩分鐘，十二條就是二十分鐘上下，
 *   再加上同網域間隔的擷取。超過的那幾條標「超過上限」，「繼續蒐集」會接著做
 * - **金額不設**：provider 不一定回報（同 `DEFAULT_BUDGET`）
 */
export const COLLECT_BUDGET = {
  maxRequests: MAX_DIRECTIONS,
  timeoutMs: 60 * 60 * 1000,
  maxCostUsd: null,
} as const;

/** 一次搜尋（一個子程序或一個 HTTP 請求）最多等多久。 */
export const SEARCH_TIMEOUT_MS = 5 * 60 * 1000;

// ── 用數的（ADR-0033 D10 的前半）─────────────────────────────

export interface DirectionTally {
  /** 找到幾份（**含別的方向也找到的**）*/
  readonly found: number;
  /** 抓到了或你上傳了 */
  readonly acquired: number;
  /** 要你拿（抓了拿不到，或依你的紀錄沒去試）*/
  readonly needsUser: number;
  /** 你說拿不到 */
  readonly unavailable: number;
  /** 還沒抓（或正在抓）*/
  readonly pending: number;
}

/**
 * 一條方向「找到 N、拿到 K、要你拿 M…」。**數的，不叫模型說**（Q4）。
 *
 * `directionIds` 是一個候選屬於哪幾條方向（第一條找到它的 ＋ 之後也找到它的）。
 */
export function tallyDirection(
  directionId: string,
  candidates: readonly {
    readonly directionIds: readonly string[];
    readonly acquisition: Acquisition;
  }[],
): DirectionTally {
  let found = 0;
  let acquired = 0;
  let needsUser = 0;
  let unavailable = 0;
  let pending = 0;
  for (const c of candidates) {
    if (!c.directionIds.includes(directionId)) continue;
    found += 1;
    if (c.acquisition === 'fetched' || c.acquisition === 'uploaded') acquired += 1;
    else if (c.acquisition === 'needs-user') needsUser += 1;
    else if (c.acquisition === 'unavailable') unavailable += 1;
    else pending += 1;
  }
  return { found, acquired, needsUser, unavailable, pending };
}

export function acquisitionOf(value: unknown): Acquisition {
  return ACQUISITIONS.includes(value as Acquisition) ? (value as Acquisition) : 'found';
}

export function expectedAccessOf(value: unknown): ExpectedAccess {
  return EXPECTED_ACCESS.includes(value as ExpectedAccess) ? (value as ExpectedAccess) : 'unknown';
}

export function unavailableReasonOf(value: unknown): UnavailableReason | null {
  return UNAVAILABLE_REASONS.includes(value as UnavailableReason)
    ? (value as UnavailableReason)
    : null;
}
