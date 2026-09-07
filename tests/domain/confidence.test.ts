import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_MIN_SAMPLE,
  calibrationOf,
  countIndependentSources,
  factsFor,
  tierOf,
} from '../../src/domain/graph/confidence.js';
import type { Evidence } from '../../src/domain/graph/types.js';

function ev(id: string, itemId: string, quote = '引文'): Evidence {
  return { id, edgeId: 'e1', itemId, quote, charStart: 0, charEnd: quote.length };
}

describe('三段等級', () => {
  it.each([
    [0, 'weak'],
    [0.39, 'weak'],
    [0.4, 'medium'],
    [0.69, 'medium'],
    [0.7, 'strong'],
    [1, 'strong'],
  ] as const)('%f -> %s', (c, expected) => {
    expect(tierOf(c)).toBe(expected);
  });
});

describe('獨立來源數', () => {
  it('沒有轉載關係時，每個 item 各算一個來源', () => {
    expect(countIndependentSources([ev('1', 'a'), ev('2', 'b'), ev('3', 'c')], [])).toBe(3);
  });

  it('同一個 item 的多筆引文只算一個來源', () => {
    expect(countIndependentSources([ev('1', 'a'), ev('2', 'a')], [])).toBe(1);
  });

  it('**出處 5 筆，獨立來源只有 2 個** —— 其中三筆是同一則的轉載', () => {
    const evidence = [ev('1', 'a'), ev('2', 'b'), ev('3', 'c'), ev('4', 'd'), ev('5', 'e')];
    // a、b、c 互為轉載；d 與 e 各自獨立 → 應該是 3
    expect(countIndependentSources(evidence, [['a', 'b', 'c']])).toBe(3);
    // 再讓 d、e 也互為轉載 → 2
    expect(
      countIndependentSources(evidence, [
        ['a', 'b', 'c'],
        ['d', 'e'],
      ]),
    ).toBe(2);
  });

  it('轉載群裡沒被引用到的 item 不會憑空多算一個來源', () => {
    expect(countIndependentSources([ev('1', 'a')], [['a', 'b', 'c']])).toBe(1);
  });
});

describe('構成事實', () => {
  it('攤開的是可以自己去查的東西，不是分數', () => {
    const facts = factsFor(0.8, [ev('1', 'a'), ev('2', 'b')], [['a', 'b']]);
    expect(facts).toEqual({
      tier: 'strong',
      evidenceCount: 2,
      independentSourceCount: 1,
      hasDirectQuote: true,
    });
  });

  it('引文是空字串時 hasDirectQuote 是 false', () => {
    expect(factsFor(0.5, [ev('1', 'a', '   ')], []).hasDirectQuote).toBe(false);
  });
});

describe('校準比例', () => {
  it('樣本不足就不給百分比 —— 一個用 4 條算出來的 75% 比沒有更糟', () => {
    const r = calibrationOf(Array(4).fill('confirmed'));
    expect(r).toEqual({ kind: 'insufficient-sample', sampleSize: 4 });
  });

  it(`剛好 ${CALIBRATION_MIN_SAMPLE} 條就給`, () => {
    const verdicts = [
      ...Array(24).fill('confirmed' as const),
      ...Array(6).fill('rejected' as const),
    ];
    const r = calibrationOf(verdicts);
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.sampleSize).toBe(30);
      expect(r.confirmedRate).toBeCloseTo(0.8);
      expect(r.rejectedRate).toBeCloseTo(0.2);
    }
  });

  it('兩個比例加起來是 1', () => {
    const r = calibrationOf([
      ...Array(17).fill('confirmed' as const),
      ...Array(18).fill('rejected' as const),
    ]);
    if (r.kind === 'ok') expect(r.confirmedRate + r.rejectedRate).toBeCloseTo(1);
  });
});
