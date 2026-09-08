import { describe, expect, it } from 'vitest';
import {
  comentionEdgeCount,
  DEFAULT_PROJECTION_THRESHOLDS,
  isValidThresholds,
  nodeEdgeCount,
  planProjection,
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

describe('投影計畫：三段各自產生什麼', () => {
  const thresholds = { minToDraw: 2, minToExpand: 3 };

  it('≥3 份 → 空心節點，不產生任何線', () => {
    const plan = planProjection(
      [{ id: 'e', mentionCount: 4, mentionedBy: ['a', 'b', 'c', 'd'] }],
      thresholds,
    );
    expect(plan.asNodes).toEqual(['e']);
    expect(plan.lines).toEqual([]);
  });

  it('=2 份 → 一條線，線中點掛著那個實體', () => {
    const plan = planProjection(
      [{ id: 'e', mentionCount: 2, mentionedBy: ['b', 'a'] }],
      thresholds,
    );
    expect(plan.asNodes).toEqual([]);
    expect(plan.lines).toEqual([{ entityId: 'e', a: 'a', b: 'b' }]);
  });

  it('1 份 → 純屬性，不畫也不連線', () => {
    const plan = planProjection([{ id: 'e', mentionCount: 1, mentionedBy: ['a'] }], thresholds);
    expect(plan.asAttributes).toEqual(['e']);
    expect(plan.lines).toEqual([]);
    expect(plan.asNodes).toEqual([]);
  });

  /**
   * 這一條守的是一個會安靜出錯的地方：分段用**全域**提及數，
   * 連線用**這一屏看得到的**。兩者混用的話，同一個實體在不同視角下
   * 會一下是節點一下是線 —— 而使用者會以為資料變了。
   */
  it('全域 3 份但這一屏只看得到 2 份 → 仍然是節點，不會退化成線', () => {
    const plan = planProjection(
      [{ id: 'e', mentionCount: 3, mentionedBy: ['a', 'b'] }],
      thresholds,
    );
    expect(plan.asNodes).toEqual(['e']);
    expect(plan.lines).toEqual([]);
  });

  it('全域 2 份但這一屏只看得到 1 份 → 0 條線，不畫一條通往看不見的東西的線', () => {
    const plan = planProjection([{ id: 'e', mentionCount: 2, mentionedBy: ['a'] }], thresholds);
    expect(plan.lines).toEqual([]);
  });

  it('同一對只畫一條線 —— 兩端排序過再組，(a,b) 與 (b,a) 不會變成兩條', () => {
    const plan = planProjection(
      [{ id: 'e', mentionCount: 2, mentionedBy: ['b', 'a', 'b', 'a'] }],
      thresholds,
    );
    expect(plan.lines).toHaveLength(1);
  });

  it('攤平出來的線數就是 comentionEdgeCount 算的那個數', () => {
    const mentionedBy = ['a', 'b', 'c', 'd'];
    const plan = planProjection([{ id: 'e', mentionCount: 4, mentionedBy }], {
      minToDraw: 2,
      minToExpand: 99,
    });
    expect(plan.lines).toHaveLength(comentionEdgeCount(mentionedBy.length));
  });
});

/**
 * **帶著一條具名關係的實體一律畫成節點。**
 *
 * 這一條來自 2026-09-08 第一次真的跑完一次擴展：
 * 一份文件抽出 5 個實體與 3 條待查證的具名關係，
 * **而圖上只有一個節點** —— 每個實體都只被那一份提到，所以全部是純屬性。
 * 工具列同時寫著「待查證 3 條」。
 */
describe('要人裁決的主張一定看得見', () => {
  it('只被一份提到、但帶著具名關係 → 畫成節點，不是純屬性', () => {
    expect(projectionFor(1, DEFAULT_PROJECTION_THRESHOLDS, true)).toBe('node');
    // 對照組：同樣只被一份提到，沒有具名關係 —— 那才是純屬性
    expect(projectionFor(1, DEFAULT_PROJECTION_THRESHOLDS, false)).toBe('attribute');
  });

  it('被兩份提到、帶著具名關係 → 節點，不再攤平成線', () => {
    expect(projectionFor(2, DEFAULT_PROJECTION_THRESHOLDS, true)).toBe('node');
    expect(projectionFor(2, DEFAULT_PROJECTION_THRESHOLDS, false)).toBe('edge');
  });

  it('planProjection 也照這條規則，而且那種實體不產生共同提及線', () => {
    const plan = planProjection([
      { id: 'ent-claim', mentionCount: 1, mentionedBy: ['itm-a'], carriesNamedEdge: true },
      { id: 'ent-plain', mentionCount: 2, mentionedBy: ['itm-a', 'itm-b'] },
    ]);
    expect(plan.asNodes).toEqual(['ent-claim']);
    expect(plan.asAttributes).toEqual([]);
    // 攤平成線的只有那個沒有主張的
    expect(plan.lines.map((l) => l.entityId)).toEqual(['ent-plain']);
  });
});
