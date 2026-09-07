import { describe, expect, it } from 'vitest';
import { evaluateProposal, tombstoneKey } from '../../src/domain/graph/tombstone.js';

describe('墓碑的比對鍵', () => {
  it('（來源, 目標, 關係型別）三者相同才是同一條', () => {
    const base = { source: 'a', target: 'b', rel: 'acquired' };
    expect(tombstoneKey(base)).toBe(tombstoneKey({ ...base }));
    expect(tombstoneKey(base)).not.toBe(tombstoneKey({ ...base, rel: 'founded' }));
  });

  it('方向有意義 —— A→B 被否決不代表 B→A 也被否決', () => {
    expect(tombstoneKey({ source: 'a', target: 'b', rel: 'r' })).not.toBe(
      tombstoneKey({ source: 'b', target: 'a', rel: 'r' }),
    );
  });
});

describe('機器提出一條邊', () => {
  const ref = { source: 'a', target: 'b', rel: 'acquired' };

  it('沒有墓碑就照常進待查證', () => {
    expect(
      evaluateProposal({
        ref,
        hasTombstone: false,
        existingEvidenceItemIds: [],
        incomingEvidenceItemIds: ['i1'],
      }),
    ).toEqual({ kind: 'accept' });
  });

  it('有墓碑而且沒有新出處 —— 擋下來', () => {
    expect(
      evaluateProposal({
        ref,
        hasTombstone: true,
        existingEvidenceItemIds: ['i1', 'i2'],
        incomingEvidenceItemIds: ['i1'],
      }),
    ).toEqual({ kind: 'blocked-by-tombstone' });
  });

  it('有墓碑但帶著新的 item —— 進待查證並標記曾被否決', () => {
    expect(
      evaluateProposal({
        ref,
        hasTombstone: true,
        existingEvidenceItemIds: ['i1'],
        incomingEvidenceItemIds: ['i2'],
      }),
    ).toEqual({ kind: 'accept-previously-rejected' });
  });

  it('同一份文件裡換一段話重講一次，不算新出處', () => {
    // 這一條是那個例外的漏洞防線：用引文字串比的話，模型換個句子就能繞過墓碑
    expect(
      evaluateProposal({
        ref,
        hasTombstone: true,
        existingEvidenceItemIds: ['i1'],
        incomingEvidenceItemIds: ['i1', 'i1'],
      }),
    ).toEqual({ kind: 'blocked-by-tombstone' });
  });

  it('完全沒有帶出處也擋下來', () => {
    expect(
      evaluateProposal({
        ref,
        hasTombstone: true,
        existingEvidenceItemIds: ['i1'],
        incomingEvidenceItemIds: [],
      }),
    ).toEqual({ kind: 'blocked-by-tombstone' });
  });
});
