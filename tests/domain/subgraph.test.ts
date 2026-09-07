/**
 * 子圖的界線：跳數、節點預算、篩選條件的正規化、轉載摺疊。
 *
 * **這一份守的是「一次要看多少是有界的」** —— 而那個界線有兩個數字，
 * 刻意不相同（預算是警示，硬上限才是拒絕）。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FILTERS,
  DEFAULT_HOPS,
  foldDerived,
  MAX_HOPS,
  NODE_BUDGET,
  normalizeFilters,
  normalizeHops,
  overBudgetHops,
  RENDER_LIMIT,
} from '../../src/domain/graph/index.js';

describe('跳數有上限，而且越界是夾住不是報錯', () => {
  it('沒給就是預設 2', () => {
    expect(normalizeHops(undefined)).toBe(DEFAULT_HOPS);
    expect(normalizeHops('')).toBe(DEFAULT_HOPS);
    expect(normalizeHops('abc')).toBe(DEFAULT_HOPS);
  });

  it('超過上限夾到上限 —— 工具列上的一個手滑不該變成 400', () => {
    expect(normalizeHops(9)).toBe(MAX_HOPS);
    expect(normalizeHops('4')).toBe(MAX_HOPS);
  });

  it('0 與負數夾到 1', () => {
    expect(normalizeHops(0)).toBe(1);
    expect(normalizeHops(-3)).toBe(1);
  });

  it('小數截斷', () => {
    expect(normalizeHops(2.9)).toBe(2);
  });
});

describe('預算與硬上限是兩個數字', () => {
  /**
   * 兩者相同的話，琥珀色警示就沒有意義 ——
   * 「超過預算」會等於「直接失敗」，那個警示無事可警。
   */
  it('硬上限明顯大於預算', () => {
    expect(RENDER_LIMIT).toBeGreaterThan(NODE_BUDGET);
  });

  it('超過預算的那幾格被標出來，而且是排序過的', () => {
    const counts = { '1': 12, '2': 143, '3': 2806 };
    expect(overBudgetHops(counts)).toEqual(['3']);
  });

  it('剛好等於預算不算超過', () => {
    expect(overBudgetHops({ '1': NODE_BUDGET })).toEqual([]);
    expect(overBudgetHops({ '1': NODE_BUDGET + 1 })).toEqual(['1']);
  });
});

describe('篩選條件的正規化', () => {
  it('預設排除已否決 —— 墓碑預設隱藏', () => {
    expect(normalizeFilters({}).statuses).toEqual(['pending', 'confirmed']);
    expect(DEFAULT_FILTERS.statuses).not.toContain('rejected');
  });

  it('認不得的值丟掉，**但不會因此變成「沒篩」**', () => {
    const filters = normalizeFilters({ layers: 'named,不存在的層' });
    expect(filters.layers).toEqual(['named']);
  });

  it('全部都認不得就等於沒指定那一項', () => {
    expect(normalizeFilters({ layers: '亂打,亂打2' }).layers).toEqual([]);
  });

  it('重複的值只留一個', () => {
    expect(normalizeFilters({ layers: 'named,named,derived' }).layers).toEqual([
      'named',
      'derived',
    ]);
  });

  it('可信度下限只吃三個等級，其餘當成沒篩', () => {
    expect(normalizeFilters({ minConfidence: 'strong' }).minTier).toBe('strong');
    expect(normalizeFilters({ minConfidence: '0.7' }).minTier).toBeNull();
  });

  it('時間範圍只吃正數', () => {
    expect(normalizeFilters({ since: '1700000000000' }).since).toBe(1_700_000_000_000);
    expect(normalizeFilters({ since: '-1' }).since).toBeNull();
    expect(normalizeFilters({ since: '不是數字' }).since).toBeNull();
  });

  it('節點型別同時管 item 的 kind 與 entity 的 type', () => {
    expect(normalizeFilters({ types: 'pdf,person' }).kinds).toEqual(['pdf', 'person']);
  });
});

describe('轉載摺進來源節點', () => {
  it('數的是「這一篇有幾個轉載」，不是「這幾篇各有一個來源」', () => {
    const folded = foldDerived([
      { source: 'a', target: 'b', layer: 'derived' },
      { source: 'a', target: 'c', layer: 'derived' },
      { source: 'a', target: 'd', layer: 'named' },
    ]);
    expect(folded.get('a')).toBe(2);
    expect(folded.has('b')).toBe(false);
  });

  it('沒有轉載就沒有這個數字 —— 不要在節點上掛一個 0', () => {
    expect(foldDerived([{ source: 'a', target: 'b', layer: 'similarity' }]).size).toBe(0);
  });
});
