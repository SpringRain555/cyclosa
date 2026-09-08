/**
 * 「復原這次作業」要刪哪些、留哪些。
 *
 * **這一份守的是一條規則：機器不得覆寫人工判定。**
 * 而「復原」是這個工具裡唯一一個由機器大規模刪除既有資料的動作 ——
 * 它是那條規則最容易被繞過的地方，因為
 * **一句 `DELETE WHERE run_id = ?` 會通過所有的型別檢查。**
 */
import { describe, expect, it } from 'vitest';

import {
  keptAnything,
  planUndo,
  type RunEdgeFact,
  type RunItemFact,
} from '../../src/domain/run/index.js';

function edge(over: Partial<RunEdgeFact> = {}): RunEdgeFact {
  return {
    id: 'edg-1',
    origin: 'machine',
    adjudicatedByHuman: false,
    evidenceItemIds: [],
    ...over,
  };
}

function item(over: Partial<RunItemFact> = {}): RunItemFact {
  return { id: 'itm-1', read: false, annotated: false, excluded: false, ...over };
}

describe('沒有人碰過的就刪掉', () => {
  it('機器提出、沒人裁決過的邊刪掉', () => {
    const plan = planUndo([edge()], []);
    expect(plan.deleteEdges).toEqual(['edg-1']);
    expect(plan.keepEdges).toEqual([]);
  });

  it('沒讀過、沒標註、沒排除的資料刪掉', () => {
    const plan = planUndo([], [item()]);
    expect(plan.deleteItems).toEqual(['itm-1']);
  });

  it('什麼都沒動過的話，`partial` 是 false —— 畫面不用多說一句話', () => {
    expect(keptAnything(planUndo([edge()], [item()]))).toBe(false);
  });
});

describe('人動過的一律留下', () => {
  it('人建立的邊留下', () => {
    const plan = planUndo([edge({ origin: 'human' })], []);
    expect(plan.keepEdges).toEqual(['edg-1']);
    expect(plan.deleteEdges).toEqual([]);
  });

  it('人裁決過的邊留下 —— 那個判斷是他做的', () => {
    const plan = planUndo([edge({ adjudicatedByHuman: true })], []);
    expect(plan.keepEdges).toEqual(['edg-1']);
  });

  it.each([
    ['讀過', { read: true }],
    ['標過點註', { annotated: true }],
    ['手動排除', { excluded: true }],
  ])('%s 的資料留下', (_label, over) => {
    const plan = planUndo([], [item(over)]);
    expect(plan.keepItems).toEqual(['itm-1']);
    expect(plan.deleteItems).toEqual([]);
  });

  it('留下任何東西就是 `partial`', () => {
    expect(keptAnything(planUndo([], [item({ read: true })]))).toBe(true);
  });
});

describe('留下來的邊的出處，那一份也要留', () => {
  it('人裁決過的邊靠 itm-9 當出處 —— itm-9 不能刪', () => {
    const plan = planUndo(
      [edge({ id: 'edg-keep', adjudicatedByHuman: true, evidenceItemIds: ['itm-9'] })],
      [item({ id: 'itm-9' })],
    );
    expect(plan.keepItems).toEqual(['itm-9']);
    // **這個理由要分得出來** —— 「你讀過它」與「有一條邊靠它」是兩句不同的話。
    expect(plan.keptAsEvidence).toEqual(['itm-9']);
  });

  it('被刪掉的邊的出處不受保護', () => {
    const plan = planUndo(
      [edge({ id: 'edg-go', evidenceItemIds: ['itm-9'] })],
      [item({ id: 'itm-9' })],
    );
    expect(plan.deleteItems).toEqual(['itm-9']);
    expect(plan.keptAsEvidence).toEqual([]);
  });

  it('人讀過**而且**是出處的那一份，只算一次而且理由是「你動過」', () => {
    const plan = planUndo(
      [edge({ adjudicatedByHuman: true, evidenceItemIds: ['itm-9'] })],
      [item({ id: 'itm-9', read: true })],
    );
    expect(plan.keepItems).toEqual(['itm-9']);
    expect(plan.keptAsEvidence).toEqual([]);
  });

  it('同一份被兩條留下來的邊引用，也只留一次', () => {
    const plan = planUndo(
      [
        edge({ id: 'a', adjudicatedByHuman: true, evidenceItemIds: ['itm-9'] }),
        edge({ id: 'b', origin: 'human', evidenceItemIds: ['itm-9'] }),
      ],
      [item({ id: 'itm-9' })],
    );
    expect(plan.keepItems).toEqual(['itm-9']);
    expect(plan.keptAsEvidence).toEqual(['itm-9']);
  });
});

describe('混合的一批', () => {
  it('一次擴展寫了 4 條邊、3 份資料，而你裁決過其中一條', () => {
    const plan = planUndo(
      [
        edge({ id: 'e1', adjudicatedByHuman: true, evidenceItemIds: ['i1'] }),
        edge({ id: 'e2', evidenceItemIds: ['i2'] }),
        edge({ id: 'e3', evidenceItemIds: ['i2'] }),
        edge({ id: 'e4', evidenceItemIds: ['i3'] }),
      ],
      [item({ id: 'i1' }), item({ id: 'i2' }), item({ id: 'i3', read: true })],
    );
    expect(plan.keepEdges).toEqual(['e1']);
    expect(plan.deleteEdges).toEqual(['e2', 'e3', 'e4']);
    // i1 是那條邊的出處、i3 你讀過 —— 只有 i2 真的走掉
    expect(plan.deleteItems).toEqual(['i2']);
    expect([...plan.keepItems].sort()).toEqual(['i1', 'i3']);
    expect(plan.keptAsEvidence).toEqual(['i1']);
  });

  it('空的一批不會爆炸，而且什麼都沒留', () => {
    const plan = planUndo([], []);
    expect(plan).toEqual({
      deleteEdges: [],
      keepEdges: [],
      deleteItems: [],
      keepItems: [],
      keptAsEvidence: [],
    });
    expect(keptAnything(plan)).toBe(false);
  });
});
