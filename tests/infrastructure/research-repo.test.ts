/**
 * 研究的三張表（schema v9）與它們守著的那一條約束。
 *
 * **「同一個專題同時只有一次研究或整理沒結束」由資料庫守**（ADR-0033 D4）——
 * 應用層「先查再寫」擋不住兩個同時進來的請求（畫面上按兩次「開始」就會發生），
 * 所以那句話要是真的，就得有測試證明資料庫會擋。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import * as research from '../../src/infrastructure/db/repositories/research-repo.js';

let dir: string;
let db: DatabaseSync;

const NOW = 1_700_000_000_000;

function start(id: string, topic = '評測方法'): void {
  research.insertResearch(db, {
    id,
    kind: 'research',
    topic,
    hitsJson: '[]',
    correlationId: `cid-${id}`,
    now: NOW,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cyclosa-research-'));
  const opened = await openCaseDatabase(join(dir, 'case.sqlite'), { create: true });
  if (opened.kind !== 'ok') throw new Error(`開不起來：${opened.kind}`);
  db = opened.db;
});

afterEach(async () => {
  db.close();
  await rm(dir, { recursive: true, force: true });
});

describe('一次研究', () => {
  it('開起來是規劃中，讀得回來', () => {
    start('r1');
    const row = research.getResearch(db, 'r1');
    expect(row?.status).toBe('planning');
    expect(row?.topic).toBe('評測方法');
    expect(row?.planJson).toBe('{}');
    expect(row?.endedAt).toBeNull();
    expect(research.openResearch(db)?.id).toBe('r1');
  });

  it('沒結束的只能有一次 —— 第二次直接被資料庫擋下來', () => {
    start('r1');
    expect(() => start('r2')).toThrow();
    // 整理也算（兩者共用同一條約束）。
    expect(() =>
      research.insertResearch(db, {
        id: 'c1',
        kind: 'consolidate',
        topic: null,
        hitsJson: '[]',
        correlationId: 'cid',
        now: NOW,
      }),
    ).toThrow();
  });

  it('結束之後就可以再開一次，而做完的可以有很多筆', () => {
    start('r1');
    research.updateResearchStatus(db, 'r1', 'done', NOW + 1);
    start('r2');
    research.updateResearchStatus(db, 'r2', 'abandoned', NOW + 2);
    start('r3');
    expect(research.listResearch(db, 10).map((r) => r.id)).toEqual(['r3', 'r2', 'r1']);
    expect(research.openResearch(db)?.id).toBe('r3');
    // 終態一定同時有結束時間 —— 「已完成但不知道什麼時候完成」讀不出意義。
    expect(research.getResearch(db, 'r1')?.endedAt).toBe(NOW + 1);
    expect(research.getResearch(db, 'r3')?.endedAt).toBeNull();
  });

  it('換規劃只動那一欄', () => {
    start('r1');
    research.updateResearchPlan(db, 'r1', '{"directions":[]}', NOW + 5);
    const row = research.getResearch(db, 'r1');
    expect(row?.planJson).toBe('{"directions":[]}');
    expect(row?.updatedAt).toBe(NOW + 5);
    expect(row?.status).toBe('planning');
  });
});

describe('對話與方向', () => {
  it('一輪一列，順序照 ord；失敗的那一輪也留著', () => {
    start('r1');
    research.insertMessage(db, {
      id: 'm1',
      researchId: 'r1',
      ord: research.nextOrd(db, 'r1'),
      role: 'user',
      content: '我想看評測方法',
      now: NOW,
    });
    research.insertMessage(db, {
      id: 'm2',
      researchId: 'r1',
      ord: research.nextOrd(db, 'r1'),
      role: 'model',
      content: '我建議分成三條',
      planJson: '{"directions":[{"title":"基準集"}]}',
      model: 'claude',
      via: 'cli',
      costUsd: 0.02,
      elapsedMs: 1200,
      now: NOW + 1,
    });
    research.insertMessage(db, {
      id: 'm3',
      researchId: 'r1',
      ord: research.nextOrd(db, 'r1'),
      role: 'model',
      content: '',
      model: 'claude',
      via: 'cli',
      code: 'PROVIDER_OUTPUT_UNPARSEABLE',
      now: NOW + 2,
    });
    const rows = research.listMessages(db, 'r1');
    expect(rows.map((r) => r.ord)).toEqual([0, 1, 2]);
    expect(rows[1]?.role).toBe('model');
    expect(rows[1]?.costUsd).toBe(0.02);
    expect(rows[2]?.code).toBe('PROVIDER_OUTPUT_UNPARSEABLE');
    expect(rows[2]?.planJson).toBeNull();
  });

  it('花費加總，而「沒回報」是另一個數字', () => {
    start('r1');
    const add = (id: string, cost: number | null): void =>
      research.insertMessage(db, {
        id,
        researchId: 'r1',
        ord: research.nextOrd(db, 'r1'),
        role: 'model',
        content: '',
        costUsd: cost,
        now: NOW,
      });
    add('m1', 0.02);
    add('m2', null);
    add('m3', 0.03);
    const cost = research.costSoFar(db, 'r1');
    expect(cost.costUsd).toBeCloseTo(0.05);
    // 合成一個數字的話，全部沒回報的那一次研究會顯示成「花了 $0.00」——
    // 對線上端點那是一句謊。
    expect(cost.unknown).toBe(1);
  });

  it('方向表存得下沒被採用的那幾條', () => {
    start('r1');
    research.insertDirection(db, {
      id: 'd1',
      researchId: 'r1',
      ord: 0,
      title: '基準集怎麼建',
      what: '',
      expect: '會議論文',
      keywords: ['benchmark', '評測'],
      origin: 'model',
      adopted: true,
      now: NOW,
    });
    research.insertDirection(db, {
      id: 'd2',
      researchId: 'r1',
      ord: 1,
      title: '你自己加的那條',
      what: '',
      expect: '',
      keywords: [],
      origin: 'human',
      adopted: true,
      now: NOW,
    });
    research.insertDirection(db, {
      id: 'd3',
      researchId: 'r1',
      ord: 2,
      title: '模型提過、你刪掉的',
      what: '',
      expect: '',
      keywords: [],
      origin: 'model',
      adopted: false,
      now: NOW,
    });
    const rows = research.listDirections(db, 'r1');
    expect(rows.map((r) => [r.origin, r.adopted])).toEqual([
      ['model', true],
      ['human', true],
      ['model', false],
    ]);
    expect(rows[0]?.keywords).toEqual(['benchmark', '評測']);
  });

  it('刪掉一次研究，對話與方向跟著走', () => {
    start('r1');
    research.insertMessage(db, {
      id: 'm1',
      researchId: 'r1',
      ord: 0,
      role: 'user',
      content: 'x',
      now: NOW,
    });
    research.insertDirection(db, {
      id: 'd1',
      researchId: 'r1',
      ord: 0,
      title: 'x',
      what: '',
      expect: '',
      keywords: [],
      origin: 'model',
      adopted: true,
      now: NOW,
    });
    expect(research.deleteResearch(db, 'r1')).toBe(true);
    expect(research.listMessages(db, 'r1')).toEqual([]);
    expect(research.listDirections(db, 'r1')).toEqual([]);
  });
});
