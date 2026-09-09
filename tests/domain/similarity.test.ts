/**
 * 向量比對（Stage 12 後半）。
 *
 * 這一支只有兩個函式，而它們各有一個**不會報錯的失效方式** ——
 * 那正是為什麼它們值得單獨測：
 *
 * | | 壞掉的樣子 |
 * |---|---|
 * | `normalized` | 全零向量除以 0 產生 `NaN`，而 `NaN` 的排序行為取決於比較順序 |
 * | `dot` | 維度不同的兩條算出一個數字，而那個數字沒有意義 |
 *
 * 兩者都不會丟例外，只會讓搜尋結果安靜地變成另一個樣子。
 */
import { describe, expect, it } from 'vitest';

import { dot, normalized } from '../../src/domain/search/similarity.js';

describe('單位化', () => {
  it('長度變成 1', () => {
    const v = normalized(Float32Array.from([3, 4]));
    expect(dot(v, v)).toBeCloseTo(1, 5);
  });

  it('方向不變', () => {
    const v = normalized(Float32Array.from([3, 4]));
    expect(v[0]).toBeCloseTo(0.6, 5);
    expect(v[1]).toBeCloseTo(0.8, 5);
  });

  /** **不要除以 0。** `NaN` 不會報錯，只會讓排序變得不確定。 */
  it('全零回原樣，不產生 NaN', () => {
    const v = normalized(Float32Array.from([0, 0, 0]));
    expect([...v]).toEqual([0, 0, 0]);
    expect(Number.isNaN(dot(v, v))).toBe(false);
  });

  it('不改原來那一份', () => {
    const original = Float32Array.from([3, 4]);
    normalized(original);
    expect([...original]).toEqual([3, 4]);
  });
});

describe('點積就是餘弦（因為兩邊都是單位向量）', () => {
  it('同方向是 1、正交是 0、反向是 -1', () => {
    const a = normalized(Float32Array.from([1, 0]));
    const b = normalized(Float32Array.from([0, 1]));
    const c = normalized(Float32Array.from([-1, 0]));
    expect(dot(a, a)).toBeCloseTo(1, 5);
    expect(dot(a, b)).toBeCloseTo(0, 5);
    expect(dot(a, c)).toBeCloseTo(-1, 5);
  });

  /**
   * **維度不同回 0，不是丟例外也不是算一個數字。**
   *
   * 這件事真的會發生：換嵌入模型的時候表裡會同時有兩種維度的向量
   * （那是過程，不是壞狀態）。查詢時 `(model, dim)` 會過濾掉它們，
   * 而這一條是最後一道 —— **算出一個數字比回 0 危險得多**，
   * 因為那個數字會參與排序。
   */
  it('維度不同回 0', () => {
    expect(dot(Float32Array.from([1, 0]), Float32Array.from([1, 0, 0]))).toBe(0);
  });
});
