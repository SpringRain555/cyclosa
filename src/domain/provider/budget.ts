/**
 * 一次擴展作業的上限（ADR-0006 的補記，Q3 的答案）。
 *
 * ## 上限有三種，不是一種
 *
 * | | 誰有 | 怎麼用 |
 * |---|---|---|
 * | **請求數** | 每個 provider 都數得到 | **主要上限**，跨 provider 可比 |
 * | 牆鐘逾時 | 每個都有 | 第二道 |
 * | 金額 | **只有 provider 自己回報實際值時** | 有就用，沒有就沒有。**不估算** |
 *
 * 選請求數當主要上限**不是因為它最容易，而是因為 2026-09-06 量到一件事**：
 * 一次只回兩個 token 的 `claude -p` 呼叫花了 0.18 美元，
 * 其中幾乎全部來自 29,310 tokens 的 cache creation。
 * **每次呼叫有很大而且大致固定的開銷** —— 在這種成本結構下，
 * 「跑了幾次」比「產生了幾個 token」更接近實際花費。
 *
 * ## 為什麼金額是 `null` 而不是 0
 *
 * 本機模型的金額成本**真的是零**，而「不知道」也會被寫成 0。
 * 兩者混在一起的話，畫面上的「已花費 $0.00」對 Ollama 是事實、
 * 對一個沒回報成本的雲端 provider 是謊。**所以沒有就是 `null`。**
 */

export interface Budget {
  /** 主要上限。**這一次作業總共可以打幾次模型** */
  readonly maxRequests: number;
  /** 牆鐘逾時（毫秒）。從第一次請求算起 */
  readonly timeoutMs: number;
  /** 金額上限（美元）。`null` ＝ 不設 —— **provider 不回報實際值時只能是 `null`** */
  readonly maxCostUsd: number | null;
}

/**
 * 預設值。**不是憑感覺**：
 *
 * - 12 次 ＝ 1 次產生視角 ＋ 最多 5 條子問題各 1 次找來源 ＋ 各 1 次抽關聯，
 *   再留一點餘裕。**勾 5 條以上時 UI 自己會擋**（`MAX_SELECTED_ANGLES`）。
 * - 10 分鐘 ＝ 5 條子問題各自要抓幾個網址，而**同網域之間有間隔**（預設 3 秒），
 *   所以擷取那一段本來就慢。逾時砍在模型那一段，不砍擷取。
 */
export const DEFAULT_BUDGET: Budget = {
  maxRequests: 12,
  timeoutMs: 10 * 60 * 1000,
  maxCostUsd: null,
};

export interface BudgetState {
  readonly requests: number;
  /** provider 回報的實際金額總和。**沒有任何一次回報過就是 `null`** */
  readonly costUsd: number | null;
  /**
   * 其中**幾次沒回報金額**（schema v10 的 `run.unpriced`）。
   *
   * `costUsd` 只加總回報過的那幾次，所以光看它分不出「每一次都回報了」與「一半沒回報」——
   * 而一次研究可能同時走 Claude Code（回報）與 OpenAI 相容 API（不回報）。
   * 畫面要說的是「花了 $0.42，另外有 3 次不知道」，不是一個看起來很精確的 $0.42。
   */
  readonly unpriced: number;
  readonly elapsedMs: number;
}

export const EMPTY_BUDGET_STATE: BudgetState = {
  requests: 0,
  costUsd: null,
  unpriced: 0,
  elapsedMs: 0,
};

/**
 * 記一次呼叫。**`reportedCostUsd` 是 `null` 就不要動 `costUsd`** ——
 * 加 0 上去會讓「從沒回報過」變成「回報過而且是 0」。
 */
export function charge(
  state: BudgetState,
  reportedCostUsd: number | null,
  elapsedMs: number,
): BudgetState {
  const costUsd = reportedCostUsd === null ? state.costUsd : (state.costUsd ?? 0) + reportedCostUsd;
  const unpriced = reportedCostUsd === null ? state.unpriced + 1 : state.unpriced;
  return { requests: state.requests + 1, costUsd, unpriced, elapsedMs };
}

export type BudgetVerdict =
  | { readonly kind: 'ok' }
  | { readonly kind: 'requests'; readonly limit: number }
  | { readonly kind: 'time'; readonly limit: number }
  | { readonly kind: 'cost'; readonly limit: number; readonly spent: number };

/**
 * **下一次呼叫之前**問一次。
 *
 * 注意它問的是「還能不能再打一次」，不是「剛剛那次有沒有超過」——
 * 上限的意義是**擋住還沒發生的花費**，事後才發現就只是一份帳單。
 */
export function mayContinue(state: BudgetState, budget: Budget): BudgetVerdict {
  if (state.requests >= budget.maxRequests) return { kind: 'requests', limit: budget.maxRequests };
  if (state.elapsedMs >= budget.timeoutMs) return { kind: 'time', limit: budget.timeoutMs };
  if (budget.maxCostUsd !== null && state.costUsd !== null && state.costUsd >= budget.maxCostUsd) {
    return { kind: 'cost', limit: budget.maxCostUsd, spent: state.costUsd };
  }
  return { kind: 'ok' };
}
