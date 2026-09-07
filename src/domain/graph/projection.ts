/**
 * 實體投影 —— **三段，門檻可調，不進資料庫**（ADR-0005 ＋ 2026-09-05 設計稿）。
 *
 * 算術：一個被 n 份文件提到的實體，當節點要 n 條線，
 * 當邊上的標籤要 n(n−1)/2 條（那 n 份兩兩相連）。**交叉點在 n=3。**
 *
 * 設計稿實測 500 篇／250 實體／每篇 5 個：
 *   全部當節點     2,500 條線
 *   全部標在線上  33,949 條線   ← 13.6 倍
 *
 * 還有一件更根本的：n 份共用一個實體，畫成線是一個 n 點的完全圖 ——
 * **那麼多條線只帶 1 bit 的資訊**（「這 n 篇共用 X」）。
 *
 * ⚠️ 零依賴（ADR-0014）。
 */

export type Projection =
  /** 只被一份文件提到 —— 純屬性，**根本不畫** */
  | 'attribute'
  /** 投影成線，線中點放一個方塊，方塊就是那個實體 */
  | 'edge'
  /** 展開成空心節點 */
  | 'node';

export interface ProjectionThresholds {
  /** 少於這個數字就是純屬性。預設 2（也就是「只被 1 份提到」不畫）。 */
  readonly minToDraw: number;
  /** 到達這個數字就展開成節點。預設 3。 */
  readonly minToExpand: number;
}

export const DEFAULT_PROJECTION_THRESHOLDS: ProjectionThresholds = {
  minToDraw: 2,
  minToExpand: 3,
};

/**
 * 一個實體被 `mentionCount` 份文件提到時，這一屏要怎麼畫它。
 *
 * **這是顯示層的計算，每一屏各自算** —— 改門檻不需要 migration。
 * `open-questions.md` Q1 記著「門檻 3 是算出來的但沒實測過」，
 * **而把它做成可調正是回答那一題的方式**：交叉點是「線比較少」的門檻，
 * 不一定是「看起來比較清楚」的門檻。
 */
export function projectionFor(
  mentionCount: number,
  thresholds: ProjectionThresholds = DEFAULT_PROJECTION_THRESHOLDS,
): Projection {
  if (mentionCount >= thresholds.minToExpand) return 'node';
  if (mentionCount >= thresholds.minToDraw) return 'edge';
  return 'attribute';
}

/**
 * 把一個實體攤平成文件之間的連線，會產生幾條線。
 *
 * 用途是工具列的節點預算 —— **在使用者按下去之前就算得出代價**。
 */
export function comentionEdgeCount(mentionCount: number): number {
  if (mentionCount < 2) return 0;
  return (mentionCount * (mentionCount - 1)) / 2;
}

/** 同一個實體當成節點要幾條線。與上面那支併看就是那個交叉點。 */
export function nodeEdgeCount(mentionCount: number): number {
  return mentionCount;
}

/**
 * 門檻設定必須合法：`minToDraw <= minToExpand`，而且兩個都至少是 1。
 * 設反了的話會出現「展開成節點但不畫」這種矛盾狀態。
 */
export function isValidThresholds(t: ProjectionThresholds): boolean {
  return (
    Number.isInteger(t.minToDraw) &&
    Number.isInteger(t.minToExpand) &&
    t.minToDraw >= 1 &&
    t.minToExpand >= 1 &&
    t.minToDraw <= t.minToExpand
  );
}
