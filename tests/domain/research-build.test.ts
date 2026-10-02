import { describe, expect, it } from 'vitest';
import {
  ACQUISITIONS,
  DECISIONS,
  FINAL_DIGEST_CODES,
  RESEARCH_STATUSES,
  defaultDecision,
  effectiveDecision,
  mayStartBuilding,
  tallyDirection,
  statusAfterBuildRun,
  mayResumeBuilding,
  mayFinishBuilding,
  type CandidateDecision,
} from '../../src/domain/research/index.js';

const candidate: CandidateDecision = {
  acquisition: 'fetched',
  relevance: null,
  digestCode: null,
  decision: null,
};

describe('確認的預設與人工選擇', () => {
  it('每種取得狀態與初讀結果都有預設', () => {
    for (const acquisition of ACQUISITIONS) {
      for (const relevance of ['yes', 'no', 'unsure', null] as const) {
        const acquired = acquisition === 'fetched' || acquisition === 'uploaded';
        expect(defaultDecision({ acquisition, relevance, digestCode: null })).toBe(
          acquired ? (relevance === 'no' ? 'discard' : 'include') : 'reference',
        );
      }
    }
  });

  it('初讀最終失敗只留；暫時失敗或還沒讀仍進圖', () => {
    for (const acquisition of ['fetched', 'uploaded'] as const) {
      for (const digestCode of FINAL_DIGEST_CODES) {
        expect(defaultDecision({ acquisition, relevance: null, digestCode })).toBe('reference');
      }
      expect(
        defaultDecision({ acquisition, relevance: null, digestCode: 'PROVIDER_TIMEOUT' }),
      ).toBe('include');
    }
  });

  it('NULL 用預設；人的選擇永遠優先，包括選得和預設一樣', () => {
    expect(effectiveDecision(candidate)).toBe('include');
    for (const decision of DECISIONS) {
      expect(effectiveDecision({ ...candidate, decision })).toBe(decision);
    }
  });

  it('閘門三只在確認中、每一筆有效選擇都齊全時放行', () => {
    for (const status of RESEARCH_STATUSES) {
      expect(mayStartBuilding(status, DECISIONS)).toBe(status === 'reviewing');
      expect(mayStartBuilding(status, ['include', null])).toBe(false);
    }
    expect(mayStartBuilding('reviewing', [effectiveDecision(candidate)])).toBe(true);
    expect(mayStartBuilding('reviewing', [])).toBe(true);
  });

  it('方向的三個數依有效選擇、共用候選在各方向只算一次', () => {
    const rows = [
      { ...candidate, directionIds: ['a', 'b', 'a'] },
      { ...candidate, directionIds: ['a'], decision: 'reference' as const },
      { ...candidate, directionIds: ['a'], relevance: 'no' as const },
    ];
    expect(tallyDirection('a', rows)).toMatchObject({
      found: 3,
      include: 1,
      reference: 1,
      discard: 1,
    });
    expect(tallyDirection('b', rows)).toMatchObject({
      found: 1,
      include: 1,
      reference: 0,
      discard: 0,
    });
    expect(tallyDirection('none', rows)).toMatchObject({
      found: 0,
      include: 0,
      reference: 0,
      discard: 0,
    });
  });
});

describe('建圖中斷', () => {
  it('取消與程式中斷都留在建圖中，只有完成才結束', () => {
    expect(statusAfterBuildRun('cancelled')).toBe('building');
    expect(statusAfterBuildRun('interrupted')).toBe('building');
    expect(statusAfterBuildRun('completed')).toBe('done');
  });
  it('停下才能繼續；只有人按取消才給到此為止', () => {
    for (const status of RESEARCH_STATUSES) {
      expect(mayResumeBuilding(status, false)).toBe(status === 'building');
      expect(mayResumeBuilding(status, true)).toBe(false);
      expect(mayFinishBuilding(status, false, 'cancelled')).toBe(status === 'building');
      expect(mayFinishBuilding(status, true, 'cancelled')).toBe(false);
      expect(mayFinishBuilding(status, false, 'interrupted')).toBe(false);
    }
  });
});
