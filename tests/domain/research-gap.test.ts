import { describe, expect, it } from 'vitest';
import { gapOf, parseGapOpinion } from '../../src/domain/research/gap.js';

describe('缺口意見的 schema', () => {
  it('只接受非空文字意見', () => {
    expect(parseGapOpinion('{"opinion":"  初讀仍不足  "}')).toBe('初讀仍不足');
    for (const raw of [
      'not json',
      'null',
      '{}',
      '{"opinion":42}',
      '{"opinion":" "}',
      '{"opinion":"可以","extra":true}',
    ]) {
      expect(parseGapOpinion(raw)).toBeNull();
    }
    expect(parseGapOpinion(JSON.stringify({ opinion: '字'.repeat(12001) }))).toBeNull();
  });

  it('讀取已存評估保留未知花費，壞資料不讓畫面失效', () => {
    const gap = { opinion: '初讀仍不足', model: 'test', costUsd: null, at: 123 };
    expect(gapOf(JSON.stringify(gap))).toEqual(gap);
    for (const raw of [null, 'null', '{}', 'broken', '{"opinion":42}']) {
      expect(gapOf(raw)).toBeNull();
    }
  });
});
