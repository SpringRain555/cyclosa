import { describe, expect, it } from 'vitest';
import {
  comentionEdgeCount,
  DEFAULT_PROJECTION_THRESHOLDS,
  isValidThresholds,
  nodeEdgeCount,
  projectionFor,
} from '../../src/domain/graph/projection.js';

describe('實體投影分三段', () => {
  it.each([
    [0, 'attribute'],
    [1, 'attribute'],
    [2, 'edge'],
    [3, 'node'],
    [40, 'node'],
  ] as const)('被 %i 份文件提到 -> %s', (n, expected) => {
    expect(projectionFor(n)).toBe(expected);
  });

  it('只被一份提到就不畫 —— 它只是那份文件的屬性', () => {
    expect(projectionFor(1)).toBe('attribute');
  });

  it('門檻可調', () => {
    expect(projectionFor(2, { minToDraw: 1, minToExpand: 2 })).toBe('node');
    expect(projectionFor(4, { minToDraw: 2, minToExpand: 5 })).toBe('edge');
  });
});

describe('交叉點在 n=3', () => {
  it('n=2 時攤平成線比較省', () => {
    expect(comentionEdgeCount(2)).toBeLessThan(nodeEdgeCount(2));
  });

  it('n=3 時打平', () => {
    expect(comentionEdgeCount(3)).toBe(nodeEdgeCount(3));
  });

  it('n>=4 之後當節點永遠比較省，而且差距越拉越開', () => {
    for (const n of [4, 5, 10, 50]) {
      expect(comentionEdgeCount(n)).toBeGreaterThan(nodeEdgeCount(n));
    }
    const gap4 = comentionEdgeCount(4) - nodeEdgeCount(4);
    const gap50 = comentionEdgeCount(50) - nodeEdgeCount(50);
    expect(gap50).toBeGreaterThan(gap4);
  });

  it('設計稿那個 500 篇／250 實體／每篇 5 個的模擬：當節點是 2,500 條線', () => {
    // 250 個實體，每個平均被 500*5/250 = 10 篇提到
    const perEntity = 10;
    const entities = 250;
    expect(nodeEdgeCount(perEntity) * entities).toBe(2500);
  });

  it('攤平成線是平方級的，而且分布越偏差距越大', () => {
    // **均勻分布下是 11,250**（45 × 250）。設計稿寫的 33,949 比這個大很多，
    // 因為它模擬的是偏態分布 —— 少數實體被很多篇提到，而 n(n−1)/2 對那些實體暴增。
    // 所以均勻分布的 11,250 是**下界**，不是設計稿那個數字。
    // 這裡驗的是「平方級」這個性質本身，不是去對那個模擬的結果。
    const uniform = comentionEdgeCount(10) * 250;
    expect(uniform).toBe(11250);
    expect(uniform).toBeGreaterThan(2500);

    // 同樣 2,500 個提及，集中在少數實體上時線數暴增
    const skewed = comentionEdgeCount(100) * 25;
    expect(skewed).toBeGreaterThan(uniform * 2);
  });
});

describe('門檻設定的合法性', () => {
  it('預設值合法', () => {
    expect(isValidThresholds(DEFAULT_PROJECTION_THRESHOLDS)).toBe(true);
  });

  it('設反了不合法 —— 否則會出現「展開成節點但不畫」這種矛盾狀態', () => {
    expect(isValidThresholds({ minToDraw: 5, minToExpand: 2 })).toBe(false);
  });

  it('零與小數不合法', () => {
    expect(isValidThresholds({ minToDraw: 0, minToExpand: 3 })).toBe(false);
    expect(isValidThresholds({ minToDraw: 1.5, minToExpand: 3 })).toBe(false);
  });
});
