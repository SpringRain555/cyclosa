/**
 * 可信度（ADR-0017）—— **三段等級 ＋ 構成事實攤開 ＋ 用自己的裁決回頭校準**。
 *
 * 缺一件就退回原來的問題：
 *   只給小數      → 兩條都是 0.62 的關聯不代表同一件事
 *   只給等級      → 「中」這個字本身不可查證
 *   不給校準比例  → 使用者沒有辦法知道自己在這類關聯上判得準不準
 *
 * ⚠️ 零依賴（ADR-0014）。
 */
import type { ConfidenceTier, Evidence } from './types.js';

/**
 * 連續分數 → 三段等級的切點。
 *
 * **這兩個數字是拍的，而且它們知道自己是拍的。**
 * ADR-0017 寫了檢查方式：如果「強」的實際確認率跟「弱」差不多，那切點就是錯的 ——
 * 而校準比例正好會把那件事量出來。
 */
export const TIER_CUTOFFS = { medium: 0.4, strong: 0.7 } as const;

export function tierOf(confidence: number): ConfidenceTier {
  if (confidence >= TIER_CUTOFFS.strong) return 'strong';
  if (confidence >= TIER_CUTOFFS.medium) return 'medium';
  return 'weak';
}

/**
 * 獨立來源數（ADR-0015）。
 *
 * **出處 5 筆可能只有 2 個獨立來源** —— 如果其中三筆是同一則的轉載。
 * 不分群的話，可信度會系統性地高估轉載多的主題（新聞類尤其嚴重）。
 *
 * 做法：把出處依它們的 `item` 分群，**同一個 `derived` 連通分量算一個來源**。
 * `derivedGroups` 由呼叫端提供（它要查 `layer='derived'` 的邊，那是 I/O）——
 * **這支函式只做分群，不碰資料庫。**
 *
 * 參數型別刻意只要求 `{ itemId }` 而不是完整的 `Evidence` ——
 * **這支只看出處出自哪一份**，引文內容與字元區間跟分群無關。
 * 要求完整的 `Evidence` 會逼呼叫端為了呼叫它而組出一堆空欄位。
 *
 * @param evidence 這條邊的全部出處
 * @param derivedGroups 每一組是一群「互為轉載」的 itemId
 */
export function countIndependentSources(
  evidence: readonly { readonly itemId: string }[],
  derivedGroups: readonly (readonly string[])[],
): number {
  // itemId → 它屬於哪一個轉載群（沒有的話自成一群）
  const groupOf = new Map<string, number>();
  derivedGroups.forEach((group, i) => {
    for (const itemId of group) groupOf.set(itemId, i);
  });

  const seenGroups = new Set<number>();
  const seenUngrouped = new Set<string>();

  for (const e of evidence) {
    const g = groupOf.get(e.itemId);
    if (g === undefined) seenUngrouped.add(e.itemId);
    else seenGroups.add(g);
  }
  return seenGroups.size + seenUngrouped.size;
}

/**
 * 構成可信度的**事實** —— 這些都是使用者可以自己去查的東西，不是分數。
 */
export interface ConfidenceFacts {
  readonly tier: ConfidenceTier;
  readonly evidenceCount: number;
  readonly independentSourceCount: number;
  readonly hasDirectQuote: boolean;
}

export function factsFor(
  confidence: number,
  evidence: readonly Evidence[],
  derivedGroups: readonly (readonly string[])[],
): ConfidenceFacts {
  return {
    tier: tierOf(confidence),
    evidenceCount: evidence.length,
    independentSourceCount: countIndependentSources(evidence, derivedGroups),
    hasDirectQuote: evidence.some((e) => e.quote.trim().length > 0),
  };
}

/**
 * 校準比例的樣本下限。
 *
 * **低於這個數字就顯示「樣本不足」，不給百分比。**
 * 一個用 4 條樣本算出來的 75%，正是 ADR-0017 要避免的那種數字。
 */
export const CALIBRATION_MIN_SAMPLE = 30;

export type Calibration =
  | { readonly kind: 'insufficient-sample'; readonly sampleSize: number }
  | {
      readonly kind: 'ok';
      readonly sampleSize: number;
      /** 0–1。UI 顯示成百分比 */
      readonly confirmedRate: number;
      readonly rejectedRate: number;
    };

/**
 * 「同一段的關聯，你過去確認了 78%、否決 22%」。
 *
 * **只採計每條邊的最新判定**（ADR-0016）—— 一條被改判三次的邊只算一票。
 * 呼叫端要先把 `edge_audit` 折成「每條邊一列」再傳進來。
 */
export function calibrationOf(latestVerdicts: readonly ('confirmed' | 'rejected')[]): Calibration {
  const n = latestVerdicts.length;
  if (n < CALIBRATION_MIN_SAMPLE) return { kind: 'insufficient-sample', sampleSize: n };

  const confirmed = latestVerdicts.filter((v) => v === 'confirmed').length;
  return {
    kind: 'ok',
    sampleSize: n,
    confirmedRate: confirmed / n,
    rejectedRate: (n - confirmed) / n,
  };
}
