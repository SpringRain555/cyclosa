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
 */
export type ItemKind = 'web' | 'pdf' | 'image' | 'text' | 'paper' | 'note';

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
