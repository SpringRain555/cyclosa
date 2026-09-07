/**
 * 專題的狀態機。轉移表的權威是 `docs/architecture/state-machines.md`。
 *
 * **沒有「已刪除」狀態** —— 刪除就是刪除，不留狀態。
 * 沒有回收桶；備份是 `backups\` 的事，不是狀態機的事（REQ-0001）。
 */

export type CaseStatus = 'new' | 'collecting' | 'ready' | 'archived';

export type CaseAction =
  /** 第一次擴展或匯入開始 */
  | 'start-collecting'
  /** 該批作業全部結束（**含部分失敗**）*/
  | 'finish-collecting'
  | 'archive'
  | 'reopen';

const TRANSITIONS: readonly {
  readonly from: CaseStatus;
  readonly action: CaseAction;
  readonly to: CaseStatus;
}[] = [
  { from: 'new', action: 'start-collecting', to: 'collecting' },
  { from: 'collecting', action: 'finish-collecting', to: 'ready' },
  { from: 'ready', action: 'start-collecting', to: 'collecting' },
  { from: 'ready', action: 'archive', to: 'archived' },
  { from: 'archived', action: 'reopen', to: 'ready' },
];

export const CASE_TRANSITIONS = TRANSITIONS;

export function nextCaseStatus(from: CaseStatus, action: CaseAction): CaseStatus | null {
  return TRANSITIONS.find((t) => t.from === from && t.action === action)?.to ?? null;
}

/**
 * 已封存的專題不能被改動。
 *
 * **要先重新開啟** —— 那一步是刻意的摩擦：封存的意思是「這件事告一段落了」，
 * 而不小心往一個已封存的專題丟東西，使用者要到很久以後才會發現。
 */
export function isMutable(status: CaseStatus): boolean {
  return status !== 'archived';
}
