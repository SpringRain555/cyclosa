import { describe, expect, it } from 'vitest';

import {
  extractedByRun,
  isUnextracted,
  type ExtractionFacts,
} from '../../src/domain/research/index.js';

const fresh: ExtractionFacts = {
  kind: 'pdf',
  status: 'included',
  extractedAt: null,
  machineEvidence: 0,
  hasBody: true,
};

describe('還沒抽過的資料（整理的第一片）', () => {
  it('匯入完成、有正文、沒抽過、沒有機器關聯拿它當出處 → 列出來', () => {
    expect(isUnextracted(fresh)).toBe(true);
    expect(isUnextracted({ ...fresh, status: 'parsed' })).toBe(true);
    expect(isUnextracted({ ...fresh, kind: 'web' })).toBe(true);
  });

  it('研究建圖抽過的（`extracted_at` 有值）不列', () => {
    expect(isUnextracted({ ...fresh, extractedAt: 1 })).toBe(false);
  });

  it('v12 以前抽過的：那一欄是空的，但有機器建的關聯拿它當出處 → 不列', () => {
    expect(isUnextracted({ ...fresh, machineEvidence: 3 })).toBe(false);
  });

  it('沒有正文（圖片、掃描件）、書目節點、筆記不列', () => {
    expect(isUnextracted({ ...fresh, hasBody: false })).toBe(false);
    expect(isUnextracted({ ...fresh, kind: 'reference' })).toBe(false);
    expect(isUnextracted({ ...fresh, kind: 'note' })).toBe(false);
  });

  it('排除的、失敗的、還沒抓完的不列', () => {
    for (const status of ['excluded', 'failed', 'pending', 'fetched']) {
      expect(isUnextracted({ ...fresh, status }), status).toBe(false);
    }
  });
});

describe('復原一筆作業時，哪些「抽過了」要清回去', () => {
  const run = { startedAt: 100, endedAt: 200 };

  it('這一筆作業區間裡寫的才清', () => {
    expect(extractedByRun(150, run, 999)).toBe(true);
    expect(extractedByRun(100, run, 999)).toBe(true);
    expect(extractedByRun(200, run, 999)).toBe(true);
  });

  it('之後被別的作業抽過（時間在區間外）的不清；沒抽過的不清', () => {
    expect(extractedByRun(250, run, 999)).toBe(false);
    expect(extractedByRun(50, run, 999)).toBe(false);
    expect(extractedByRun(null, run, 999)).toBe(false);
  });

  it('還沒結束的作業用現在當區間的尾巴；沒開始過的不清', () => {
    expect(extractedByRun(500, { startedAt: 100, endedAt: null }, 999)).toBe(true);
    expect(extractedByRun(150, { startedAt: null, endedAt: null }, 999)).toBe(false);
  });
});

describe('整理操作清單（Stage 24 issue #4）', () => {
  it('整份 schema 不合時拒收規劃，空白 why 也不接受', async () => {
    const { parseConsolidatePlan } = await import('../../src/domain/research/consolidate.js');
    expect(
      parseConsolidatePlan(
        JSON.stringify({
          operations: [
            { kind: 'merge', payload: { keep: 'a', drop: 'b' }, why: '合成理由' },
            { kind: 'retype', payload: { entityId: 'e', to: 'unknown' }, why: '型別錯誤' },
          ],
        }),
      ),
    ).toBeNull();
    expect(
      parseConsolidatePlan(
        JSON.stringify({
          operations: [{ kind: 'extract', payload: { itemIds: ['i'] }, why: '   ' }],
        }),
      ),
    ).toBeNull();
  });

  it('逐種拒絕對不到資料或對不到原文的提案，保留原因', async () => {
    const { consolidateQuoteKey, validateConsolidatePlan } =
      await import('../../src/domain/research/consolidate.js');
    const result = validateConsolidatePlan(
      [
        { kind: 'merge', payload: { keep: 'missing', drop: 'e1' }, why: 'merge' },
        { kind: 'merge', payload: { keep: 'e1', drop: 'e1' }, why: 'same' },
        { kind: 'extract', payload: { itemIds: ['missing'] }, why: 'extract' },
        {
          kind: 'add-edge',
          payload: {
            source: 'missing',
            target: 'e1',
            rel: '關係',
            itemId: 'i1',
            quote: '這是一段可以定位的引文',
          },
          why: 'edge-id',
        },
        {
          kind: 'add-edge',
          payload: {
            source: 'e1',
            target: 'i1',
            rel: '關係',
            itemId: 'i1',
            quote: '這是一段不存在的引文',
          },
          why: 'edge-quote',
        },
        { kind: 'retype', payload: { entityId: 'missing', to: 'person' }, why: 'retype' },
        { kind: 'digest', payload: { itemIds: ['missing'] }, why: 'digest' },
      ],
      {
        liveEntityIds: new Set(['e1', 'e2']),
        itemIds: new Set(['i1']),
        extractableItemIds: new Set(['i1']),
        endpointIds: new Set(['e1', 'e2', 'i1']),
        verifiedQuoteKeys: new Set([consolidateQuoteKey('i1', '存在的引文文字足夠長')]),
      },
    );
    expect(result.operations).toEqual([]);
    expect(result.dropped.map(({ reason }) => reason)).toEqual([
      'merge-id-missing',
      'merge-same-id',
      'extract-item-not-unextracted',
      'edge-id-missing',
      'edge-quote-not-found',
      'retype-entity-missing',
      'digest-item-missing',
    ]);
  });

  it('固定合併、改型別、抽取、加關聯、補繁中的順序，同類保留原順序', async () => {
    const { orderConsolidateOps, isConsolidateOpStale } =
      await import('../../src/domain/research/consolidate.js');
    const sorted = orderConsolidateOps([
      { kind: 'digest' as const, ord: 0 },
      { kind: 'extract' as const, ord: 2 },
      { kind: 'merge' as const, ord: 3 },
      { kind: 'extract' as const, ord: 1 },
      { kind: 'retype' as const, ord: 4 },
      { kind: 'add-edge' as const, ord: 5 },
    ]);
    expect(sorted.map(({ kind, ord }) => [kind, ord])).toEqual([
      ['merge', 3],
      ['retype', 4],
      ['extract', 1],
      ['extract', 2],
      ['add-edge', 5],
      ['digest', 0],
    ]);
    expect(isConsolidateOpStale('proposed', false)).toBe(true);
    expect(isConsolidateOpStale('proposed', true)).toBe(false);
    expect(isConsolidateOpStale('done', false)).toBe(false);
  });
});
