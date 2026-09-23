/**
 * 資料節點與擴展作業的狀態機。
 * 轉移表的權威是 `docs/architecture/state-machines.md`。
 */

// ── 資料節點 Item ──────────────────────────────────────────

/**
 * 資料節點的型別。值域與 `item.kind` 的 CHECK 一致。
 *
 * `note` 在這裡是因為點註也是圖上的節點（ADR-0010），
 * 但它不走擷取管線 —— 它沒有 snapshot，也不會有 `kind='note'` 的 fetch。
 * `reference`（書目節點，schema v10）也一樣沒有快照：研究裡拿不到、只留書目的那一份。
 */
export type ItemKind = 'web' | 'pdf' | 'image' | 'text' | 'note' | 'reference';

export type ItemStatus = 'pending' | 'fetched' | 'parsed' | 'included' | 'excluded' | 'failed';

export type ItemAction =
  | 'fetched'
  | 'parsed'
  | 'include'
  /** **只由人設定。機器不會自己排除任何東西。** */
  | 'exclude'
  | 'restore'
  | 'fail'
  | 'retry';

const ITEM_TRANSITIONS: readonly {
  readonly from: ItemStatus;
  readonly action: ItemAction;
  readonly to: ItemStatus;
  /** 只有人能推動的轉移。 */
  readonly humanOnly?: true;
}[] = [
  { from: 'pending', action: 'fetched', to: 'fetched' },
  { from: 'fetched', action: 'parsed', to: 'parsed' },
  { from: 'parsed', action: 'include', to: 'included' },

  { from: 'pending', action: 'exclude', to: 'excluded', humanOnly: true },
  { from: 'fetched', action: 'exclude', to: 'excluded', humanOnly: true },
  { from: 'parsed', action: 'exclude', to: 'excluded', humanOnly: true },
  { from: 'included', action: 'exclude', to: 'excluded', humanOnly: true },
  { from: 'excluded', action: 'restore', to: 'pending', humanOnly: true },

  { from: 'pending', action: 'fail', to: 'failed' },
  { from: 'fetched', action: 'fail', to: 'failed' },
  { from: 'failed', action: 'retry', to: 'pending' },
];

export const ITEM_TRANSITION_TABLE = ITEM_TRANSITIONS;

export type Actor = 'human' | 'machine';

export function nextItemStatus(
  from: ItemStatus,
  action: ItemAction,
  actor: Actor,
): ItemStatus | null {
  const row = ITEM_TRANSITIONS.find((t) => t.from === from && t.action === action);
  if (row === undefined) return null;
  if (row.humanOnly === true && actor !== 'human') return null;
  return row.to;
}

/**
 * 「已讀」**不是狀態**，是正交旗標（`item.read_at`）。
 *
 * 把它塞進上面那張表會讓狀態數翻倍，而且沒有意義 ——
 * 一份已納入的資料可以已讀或未讀，兩者都正常。
 * 這支函式存在只是為了讓這件事有一個寫下來的地方。
 */
export const READ_IS_NOT_A_STATUS = true;

// ── 擴展作業 Run ───────────────────────────────────────────

export type RunStatus = 'queued' | 'running' | 'done' | 'partial' | 'cancelled' | 'failed';

/**
 * 作業的種類。值域與 `run.kind` 的 CHECK 一致（schema v10）。
 *
 * `research` 是一次研究裡的機器工作（蒐集一筆、建圖一筆 —— ADR-0033 D3）；
 * `consolidate` 是整理（Stage 24）。`expand` 是舊版擴展，Stage 22 退場。
 */
export type RunKind = 'import' | 'expand' | 'research' | 'consolidate';

/**
 * **不是狀態，是「這次取消是誰按的」。**
 *
 * 關掉程式與使用者按取消對一個正在跑的作業是同一件事：不再往下做、
 * 已寫入的保留（ADR-0023）。所以它們共用 `cancelled`，**不新增第七個狀態** ——
 * 多一個狀態值會讓每一個讀 `status` 的地方都要多處理一種情形。
 *
 * `null`（沒有這個值）＝ 使用者自己按的。其餘兩個見
 * `migrations/008-run-ended-reason.sql`。
 *
 * **`stale` 的意思是「上一次結束時它還沒跑完」，不是「當掉了」** ——
 * 掃描分不出那次結束是按了結束鍵（而作業沒趕上收尾）還是被強制結束的。
 */
export type RunEndedReason = 'shutdown' | 'stale';

export type RunAction =
  | 'start'
  /** 全部項目成功 */
  | 'complete'
  /** **個別項目失敗，其餘照常寫入** */
  | 'complete-partial'
  /** 使用者中止 —— **已寫入的保留** */
  | 'cancel'
  /** 整批無法開始（例如 provider 配不上）*/
  | 'fail';

const RUN_TRANSITIONS: readonly {
  readonly from: RunStatus;
  readonly action: RunAction;
  readonly to: RunStatus;
}[] = [
  { from: 'queued', action: 'start', to: 'running' },
  { from: 'queued', action: 'cancel', to: 'cancelled' },
  { from: 'running', action: 'complete', to: 'done' },
  { from: 'running', action: 'complete-partial', to: 'partial' },
  { from: 'running', action: 'cancel', to: 'cancelled' },
  { from: 'running', action: 'fail', to: 'failed' },
];

export const RUN_TRANSITION_TABLE = RUN_TRANSITIONS;

export function nextRunStatus(from: RunStatus, action: RunAction): RunStatus | null {
  return RUN_TRANSITIONS.find((t) => t.from === from && t.action === action)?.to ?? null;
}

/**
 * **`partial` 不是「失敗」的一種。**
 *
 * 一批 40 個 URL 有 3 個 404，其餘 37 個的內容不該跟著消失。
 * 把它併進 `failed` 是最容易犯、也最傷的簡化 ——
 * 所以這裡給它一支自己的判斷函式，而不是讓每個呼叫端自己寫 `status !== 'done'`。
 */
export function producedUsableOutput(status: RunStatus): boolean {
  return status === 'done' || status === 'partial' || status === 'cancelled';
}

/**
 * 一批作業結束時該進哪個狀態。
 *
 * **這支函式就是「部分失敗是一等公民」的實作點。**
 */
export function settleRun(succeeded: number, failed: number): RunAction {
  if (failed === 0) return 'complete';
  if (succeeded === 0) return 'fail';
  return 'complete-partial';
}

/**
 * 一條切入角度的結局。
 *
 * **匯入的「一項」只有成功或失敗兩種，擴展的「一條角度」有三種**：
 * 它可能**做出了東西，同時有一部分沒做成**
 * （例如模型抽了 8 條關係，其中 5 條的引文在原文裡找不到）。
 */
export type AngleOutcome = 'clean' | 'degraded' | 'failed';

export function angleOutcome(input: {
  readonly code: string | null;
  /** 那個碼是不是 `error` 級 —— 那種要整批停下來 */
  readonly fatal: boolean;
  /** 這條角度有沒有做出任何東西（找到網址、寫進節點或關聯）*/
  readonly produced: boolean;
}): AngleOutcome {
  if (input.code === null) return 'clean';
  if (input.fatal || !input.produced) return 'failed';
  return 'degraded';
}

/**
 * 一次擴展結束時該進哪個狀態。
 *
 * ## 為什麼不能直接用 `settleRun`
 *
 * `settleRun` 只認得兩種輸入，於是「有碼」就得被歸進 `failed` ——
 * 而**那會讓一次寫進 1 個節點與 9 條關聯的作業被標成「失敗」**。
 *
 * 那不是假想的。2026-09-08 第一次真的跑一次擴展：
 * agent 找到 6 個學術來源，其中 5 個是付費牆（`FETCH_LOGIN_REQUIRED` ——
 * 工具照規則不繞過），剩下那一個抽出了 1 個節點與 9 條關聯，
 * 而模型給的引文有幾條在原文裡找不到。
 * 結果那次作業的狀態是 **`失敗`** —— 而畫面上同時列著它寫進去的東西。
 *
 * **「部分失敗被併進失敗」是這個專案明寫要避免的那條**，
 * 而它在一支只認得兩個數字的函式後面又發生了一次。
 */
export function settleAngles(outcomes: readonly AngleOutcome[]): RunAction {
  if (outcomes.every((o) => o === 'clean')) return 'complete';
  // **只要有一條做出了東西，這次作業就不是「失敗」。**
  if (outcomes.some((o) => o === 'clean' || o === 'degraded')) return 'complete-partial';
  return 'fail';
}
