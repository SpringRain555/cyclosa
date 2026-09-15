/**
 * 關聯的狀態機 —— **六條轉移，執行者全部是人。**
 *
 * 轉移表的權威是 `docs/architecture/state-machines.md`，這一份是它的可執行版本。
 * **兩邊不一致時以文件為準，然後回來改這裡。**
 *
 * ⚠️ 零依賴（ADR-0014）：這個檔案不 import 任何東西。
 */
import type { EdgeLayer, EdgeOrigin, EdgeStatus } from './types.js';

/**
 * 六個動作。**沒有一個的執行者是機器。**
 *
 * `withdraw` 與兩個方向的 `reclassify` 是 2026-09-06 從設計稿回寫進來的 ——
 * 在那之前 `confirmed` 是終點，而「先確認、後來把出處讀完才發現判斷錯了」很常發生。
 */
export type EdgeAction =
  /** 待查證 → 已確認 */
  | 'confirm'
  /** 待查證 → 已否決 */
  | 'reject'
  /** 已確認 → 待查證。**撤回確認** */
  | 'withdraw'
  /** 已確認 → 已否決 ／ 已否決 → 已確認。**改判** */
  | 'reclassify'
  /** 已否決 → 待查證。**復原** */
  | 'restore';

export const EDGE_ACTIONS: readonly EdgeAction[] = [
  'confirm',
  'reject',
  'withdraw',
  'reclassify',
  'restore',
];

/**
 * 完整轉移表。**這張表就是規格** —— 不在表上的組合一律非法。
 *
 * 刻意寫成資料而不是一串 if：一張表可以被逐列測試，
 * 而一串 if 只能被「我想得到的那幾種」測試。
 */
const TRANSITIONS: readonly {
  readonly from: EdgeStatus;
  readonly action: EdgeAction;
  readonly to: EdgeStatus;
}[] = [
  { from: 'pending', action: 'confirm', to: 'confirmed' },
  { from: 'pending', action: 'reject', to: 'rejected' },
  { from: 'confirmed', action: 'withdraw', to: 'pending' },
  { from: 'confirmed', action: 'reclassify', to: 'rejected' },
  { from: 'rejected', action: 'restore', to: 'pending' },
  { from: 'rejected', action: 'reclassify', to: 'confirmed' },
];

export const EDGE_TRANSITIONS = TRANSITIONS;

export type TransitionOutcome =
  | { readonly kind: 'ok'; readonly to: EdgeStatus }
  /** 不在轉移表上 */
  | { readonly kind: 'invalid-transition' }
  /** 要標成已確認，但它是機器產生的而且沒有任何出處 */
  | { readonly kind: 'evidence-required' };

export interface TransitionInput {
  readonly from: EdgeStatus;
  readonly action: EdgeAction;
  readonly origin: EdgeOrigin;
  /** 這條邊目前有幾筆 `edge_evidence`。 */
  readonly evidenceCount: number;
}

/**
 * 算出一次轉移的結果。**純函式，不寫任何東西。**
 *
 * 兩條約束在這裡一起檢查，因為它們會一起被違反：
 * 1. 轉移必須在表上
 * 2. **`confirmed` 需要至少一筆出處，除非 `origin === 'human'`**
 *    （人手動建立的關聯，出處就是那個人）
 */
export function transition(input: TransitionInput): TransitionOutcome {
  const row = TRANSITIONS.find((t) => t.from === input.from && t.action === input.action);
  if (row === undefined) return { kind: 'invalid-transition' };

  if (row.to === 'confirmed' && input.origin === 'machine' && input.evidenceCount < 1) {
    return { kind: 'evidence-required' };
  }
  return { kind: 'ok', to: row.to };
}

/** 從某個狀態出發，現在可以做哪些動作 —— UI 用它決定按鈕要不要 disabled。 */
export function actionsFrom(from: EdgeStatus): readonly EdgeAction[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.action);
}

/**
 * **機器永遠不得覆寫人工判定。**
 *
 * 「只新增不推翻」不夠 —— 見 `tombstone.ts`。這一條管的是另一半：
 * **被人碰過的邊，重跑只附加出處、狀態不變**；
 * 待查證的邊可以被重跑更新可信度（沒有人判斷過它，所以沒有東西被覆寫）。
 */
export function machineMayUpdateStatus(current: EdgeStatus, everAdjudicated: boolean): boolean {
  if (everAdjudicated) return false;
  return current === 'pending';
}

/**
 * 這條邊裁決得動嗎 —— **open-questions Q6 的答案**（2026-09-08）。
 *
 * ## 判準不是層別，是「它會不會被重算蓋掉」
 *
 * 直覺的規則是「只有 `named` 能裁決」，因為只有那一層進裁決佇列（ADR-0015）。
 * **但那條規則的理由不是層別本身**：另外三層是可重算的計算結果
 * （`isRecomputable`），而**在一個下次重算就會被蓋掉的東西上按「已確認」，
 * 比不給按更糟** —— 使用者的判斷會安靜地消失，
 * 而那正是狀態機規則 1 要擋的那件事。
 *
 * 那個理由對 `origin='human'` 的列**不成立**：重算永遠不碰人建的列
 * （規則 1 ＋ `trg_edge_human_row_immutable`），所以一條人手動建的「轉載」
 * 沒有任何東西會蓋掉它，撤回得動也應該撤回得動 ——
 * 否則人建錯一條就再也拿不掉（api-contract 沒有刪除端點）。
 *
 * 所以規則裡有 `origin`，正如 Q6 自己預料的那樣。
 */
export function mayAdjudicate(input: {
  readonly layer: EdgeLayer;
  readonly origin: EdgeOrigin;
}): boolean {
  return input.layer === 'named' || input.origin === 'human';
}
