/**
 * 初讀量測的計分要照 `docs/research/digest-measurement.md` 寫的算 ——
 * 一個全部都很低的分數表跟一支寫壞的計分程式長得一模一樣，所以先用知道答案的列驗它。
 */
import { describe, expect, it } from 'vitest';

import {
  agreement,
  hasCjk,
  majorityBaseline,
  median,
  scoreRound,
  sentenceCount,
  type DigestRow,
} from '../../tools/research/score-digest.js';

function row(over: Partial<DigestRow> & Pick<DigestRow, 'itemId' | 'relevance'>): DigestRow {
  return {
    group: 'main',
    model: 'm',
    round: 1,
    cold: false,
    schemaValid: over.relevance !== null,
    titleZhOk: true,
    summaryLe3: true,
    seconds: 5,
    code: over.relevance === null ? 'PROVIDER_OUTPUT_UNPARSEABLE' : null,
    ...over,
  };
}

const gold = new Map<string, 'yes' | 'no' | 'unsure'>([
  ['a', 'yes'],
  ['b', 'yes'],
  ['c', 'no'],
  ['d', 'unsure'],
  ['law1', 'no'],
  ['law2', 'no'],
]);

describe('scoreRound', () => {
  it('正確率、反轉數、unsure 率、對照組與中位數各算各的', () => {
    const rows: DigestRow[] = [
      row({ itemId: 'a', relevance: 'yes', cold: true, seconds: 60 }),
      row({ itemId: 'b', relevance: 'no', seconds: 4 }), // gold yes → no：反轉
      row({ itemId: 'c', relevance: 'unsure', seconds: 6 }), // gold no → unsure：錯但不是反轉
      row({ itemId: 'd', relevance: 'unsure', seconds: 8 }),
      row({ itemId: 'law1', relevance: 'no', group: 'control', seconds: 2 }),
      row({ itemId: 'law2', relevance: 'yes', group: 'control', seconds: 3 }), // 對照組判有關
      row({ itemId: 'nogold', relevance: null, seconds: null }), // 沒有 gold、也沒解析出來
    ];
    const s = scoreRound(rows, gold);
    expect(s.n).toBe(7);
    expect(s.schemaValid).toBe(6);
    expect(s.scored).toBe(6);
    expect(s.exact).toBe(3); // a、d、law1
    expect(s.accuracy).toBeCloseTo(0.5);
    expect(s.inversions).toBe(2); // b（yes→no）、law2（no→yes）
    expect(s.unsureCount).toBe(2);
    expect(s.unsureRate).toBeCloseTo(2 / 7);
    expect(s.controlN).toBe(2);
    expect(s.controlNo).toBe(1);
    expect(s.controlAllNo).toBe(false);
    expect(s.coldSeconds).toBe(60);
    // 中位數不含冷啟動那一份：4、6、8、2、3 → 4
    expect(s.medianSeconds).toBe(4);
  });

  it('沒有對照組就說不出「全 no」；沒有 gold 就沒有正確率', () => {
    const s = scoreRound([row({ itemId: 'x', relevance: 'yes' })], new Map());
    expect(s.controlAllNo).toBeNull();
    expect(s.accuracy).toBeNull();
    expect(s.scored).toBe(0);
  });
});

describe('基準線與一致率', () => {
  it('多數類基準線是 gold 裡最多的那個值', () => {
    expect(majorityBaseline(gold)).toEqual({ label: 'no', accuracy: 0.5 });
    expect(majorityBaseline(new Map())).toBeNull();
  });

  it('兩輪一致率只算兩輪都有結果的', () => {
    const r1 = [
      row({ itemId: 'a', relevance: 'yes' }),
      row({ itemId: 'b', relevance: 'no' }),
      row({ itemId: 'c', relevance: null }),
    ];
    const r2 = [
      row({ itemId: 'a', relevance: 'yes', round: 2 }),
      row({ itemId: 'b', relevance: 'unsure', round: 2 }),
      row({ itemId: 'c', relevance: 'no', round: 2 }),
    ];
    expect(agreement(r1, r2)).toEqual({ same: 1, of: 2 });
  });
});

describe('小工具', () => {
  it('句數以 。！？!? 算，空字串 0 句', () => {
    expect(sentenceCount('')).toBe(0);
    expect(sentenceCount('一句。')).toBe(1);
    expect(sentenceCount('一句。兩句！三句？四句。')).toBe(4);
    expect(sentenceCount('沒有句號')).toBe(1);
  });

  it('繁中標題至少要有中日韓字元', () => {
    expect(hasCjk('卷積網路')).toBe(true);
    expect(hasCjk('Convolutional Networks')).toBe(false);
  });

  it('中位數', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
