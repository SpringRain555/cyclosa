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
  it('v12：缺口評估與建圖作業可更新、清空，不動規劃', () => {
    start('r1');
    expect(research.getResearch(db, 'r1')).toMatchObject({ gapJson: null, buildRunId: null });
    db.exec(
      "INSERT INTO run (id, kind, status, correlation_id, created_at) VALUES ('build1', 'research', 'running', 'cid', 1)",
    );
    research.setGap(db, 'r1', '{"gaps":[]}', NOW + 1);
    research.setBuildRun(db, 'r1', 'build1', NOW + 2);
    expect(research.getResearch(db, 'r1')).toMatchObject({
      gapJson: '{"gaps":[]}',
      buildRunId: 'build1',
      planJson: '{}',
      updatedAt: NOW + 2,
    });
    research.setGap(db, 'r1', null, NOW + 3);
    research.setBuildRun(db, 'r1', null, NOW + 3);
    expect(research.getResearch(db, 'r1')).toMatchObject({ gapJson: null, buildRunId: null });
  });

  it('v12：人工選擇、引用與建圖進度各自保存，重設後回預設', () => {
    start('r1');
    direction('d1');
    add('c1', 'https://example.test/1');
    add('c2', 'https://example.test/2');
    expect(research.getCandidate(db, 'c1')).toMatchObject({
      decision: null,
      citedBy: [],
      buildState: null,
      buildCode: null,
    });
    research.setCandidateDecision(db, 'c1', 'include', NOW + 1);
    research.setCandidateCitedBy(db, 'c1', ['c2'], NOW + 2);
    research.setCandidateBuild(db, {
      id: 'c1',
      state: 'failed',
      code: 'PROVIDER_TIMEOUT',
      now: NOW + 3,
    });
    expect(research.listCandidates(db, 'r1')[0]).toMatchObject({
      decision: 'include',
      citedBy: ['c2'],
      buildState: 'failed',
      buildCode: 'PROVIDER_TIMEOUT',
      updatedAt: NOW + 3,
    });
    expect(research.getCandidate(db, 'c2')).toMatchObject({
      decision: null,
      citedBy: [],
      buildState: null,
    });
    research.setCandidateBuild(db, {
      id: 'c1',
      state: 'done',
      code: 'PROVIDER_TIMEOUT',
      now: NOW + 4,
    });
    expect(research.getCandidate(db, 'c1')).toMatchObject({ buildState: 'done', buildCode: null });
    research.setCandidateDecision(db, 'c1', null, NOW + 5);
    research.setCandidateCitedBy(db, 'c1', [], NOW + 5);
    research.setCandidateBuild(db, { id: 'c1', state: null, code: null, now: NOW + 5 });
    expect(research.getCandidate(db, 'c1')).toMatchObject({
      decision: null,
      citedBy: [],
      buildState: null,
      buildCode: null,
    });
  });
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

// ══ v10：候選、方向的搜尋狀態、作業的花費 ═══════════════════

function direction(id: string, researchId = 'r1', ord = 0): void {
  research.insertDirection(db, {
    id,
    researchId,
    ord,
    title: `方向 ${id}`,
    what: '',
    expect: '',
    keywords: [],
    origin: 'model',
    adopted: true,
    now: NOW,
  });
}

function add(id: string, url: string, directionId = 'd1'): boolean {
  return research.addCandidate(db, {
    id,
    researchId: 'r1',
    directionId,
    url,
    title: `標題 ${id}`,
    why: '理由',
    bib: { authors: '甲', year: '2024', venue: '' },
    expectedAccess: 'unknown',
    acquisition: 'found',
    now: NOW,
  });
}

describe('候選（v10）', () => {
  it('同一次研究裡同一個網址只有一列；第二條方向找到的記在 also_directions', () => {
    start('r1');
    direction('d1');
    direction('d2', 'r1', 1);
    expect(add('c1', 'https://a.example/1')).toBe(true);
    expect(add('c2', 'https://b.example/2')).toBe(true);
    expect(add('c3', 'https://a.example/1', 'd2')).toBe(false);
    // 同一條方向又找到一次 —— 不重複記。
    expect(add('c4', 'https://a.example/1', 'd2')).toBe(false);

    const rows = research.listCandidates(db, 'r1');
    expect(rows.map((r) => [r.id, r.ord, r.alsoDirections])).toEqual([
      ['c1', 0, ['d2']],
      ['c2', 1, []],
    ]);
    expect(rows[0]?.bib).toEqual({ authors: '甲', year: '2024', venue: '' });
  });

  it('「拿不到」一定帶原因、原因只跟「拿不到」一起出現 —— 資料庫守著', () => {
    start('r1');
    direction('d1');
    add('c1', 'https://a.example/1');
    research.markUnavailable(db, { id: 'c1', reason: 'paywall', note: '沒有訂閱', now: NOW });
    expect(research.getCandidate(db, 'c1')).toMatchObject({
      acquisition: 'unavailable',
      unavailableReason: 'paywall',
      reasonNote: '沒有訂閱',
    });
    // 改回要你拿：原因一起清掉（不清的話 CHECK 會擋下來）。
    research.setAcquisition(db, { id: 'c1', acquisition: 'needs-user', code: null, now: NOW });
    expect(research.getCandidate(db, 'c1')).toMatchObject({
      acquisition: 'needs-user',
      unavailableReason: null,
      reasonNote: '',
    });
    expect(() =>
      db
        .prepare(`UPDATE research_candidate SET unavailable_reason = 'paywall' WHERE id = 'c1'`)
        .run(),
    ).toThrow(/CHECK/);
    expect(() =>
      db.prepare(`UPDATE research_candidate SET acquisition = 'unavailable' WHERE id = 'c1'`).run(),
    ).toThrow(/CHECK/);
  });

  it('停在半路的「抓取中」放回「還沒抓」', () => {
    start('r1');
    direction('d1');
    add('c1', 'https://a.example/1');
    research.setAcquisition(db, { id: 'c1', acquisition: 'fetching', code: null, now: NOW });
    expect(research.resetFetching(db, 'r1', NOW)).toBe(1);
    expect(research.getCandidate(db, 'c1')?.acquisition).toBe('found');
  });

  it('刪掉研究，候選跟著走', () => {
    start('r1');
    direction('d1');
    add('c1', 'https://a.example/1');
    research.updateResearchStatus(db, 'r1', 'abandoned', NOW);
    expect(research.deleteResearch(db, 'r1')).toBe(true);
    expect(research.listCandidates(db, 'r1')).toEqual([]);
  });
});

describe('方向的搜尋狀態與研究的狀態（v10）', () => {
  it('搜過、搜失敗分得開', () => {
    start('r1');
    direction('d1');
    direction('d2', 'r1', 1);
    research.markDirectionSearched(db, { id: 'd1', state: 'done', code: null, now: NOW });
    research.markDirectionSearched(db, {
      id: 'd2',
      state: 'failed',
      code: 'PROVIDER_TIMEOUT',
      now: NOW,
    });
    expect(research.listDirections(db, 'r1').map((d) => [d.searchState, d.searchCode])).toEqual([
      ['done', null],
      ['failed', 'PROVIDER_TIMEOUT'],
    ]);
  });

  it('**條件式換狀態**：已經不在那一步了就不換（放棄之後，蒐集收尾不會把它蓋回等你）', () => {
    start('r1');
    research.updateResearchStatus(db, 'r1', 'collecting', NOW);
    research.updateResearchStatus(db, 'r1', 'abandoned', NOW);
    expect(research.moveResearchIf(db, 'r1', 'collecting', 'awaiting-user', NOW)).toBe(false);
    expect(research.getResearch(db, 'r1')?.status).toBe('abandoned');
  });

  it('花費把對話與作業加起來；作業裡沒回報的次數另外數', () => {
    start('r1');
    research.insertMessage(db, {
      id: 'm1',
      researchId: 'r1',
      ord: 0,
      role: 'model',
      content: 'x',
      costUsd: 0.02,
      now: NOW,
    });
    db.prepare(
      `INSERT INTO run (id, kind, status, correlation_id, created_at, research_id, cost_usd, unpriced,
                        requests, task_costs_json)
       VALUES ('run1', 'research', 'done', 'c', 1, 'r1', 0.3, 2, 3, NULL),
              ('run2', 'research', 'done', 'c', 2, 'r1', NULL, 1, 1, NULL),
              ('other', 'import', 'done', 'c', 3, NULL, 9, 5, 0, NULL),
              ('run3', 'research', 'done', 'c', 4, 'r1', 0.05, 0, 3,
               '{"find-sources":{"requests":1,"costUsd":0.05,"unpriced":0},"digest":{"requests":2,"costUsd":0,"unpriced":0}}')`,
    ).run();
    const cost = research.costSoFar(db, 'r1');
    expect(cost.costUsd).toBeCloseTo(0.37);
    expect(cost.unknown).toBe(3);
    // **逐任務（v11）**：拆開的那幾格加起來等於總數。v11 以前的蒐集作業沒有拆 ——
    // 那時候它只做找來源，所以整份算在找來源底下（不然拆開的會比總數少）。
    expect(cost.byTask['plan']).toEqual({ requests: 1, costUsd: 0.02, unpriced: 0 });
    expect(cost.byTask['find-sources']).toMatchObject({ requests: 5, unpriced: 3 });
    expect(cost.byTask['find-sources']?.costUsd).toBeCloseTo(0.35);
    expect(cost.byTask['digest']).toEqual({ requests: 2, costUsd: 0, unpriced: 0 });
    expect(research.listResearchRunIds(db, 'r1')).toEqual(['run3', 'run2', 'run1']);
  });

  it('閱讀器的候選標籤只認還沒結束的那一次研究', () => {
    start('r1');
    direction('d1');
    db.prepare(
      `INSERT INTO item (id, kind, title, status, created_at, updated_at)
       VALUES ('i1', 'web', '一份', 'included', 1, 1)`,
    ).run();
    add('c1', 'https://a.example/1');
    research.setAcquisition(db, {
      id: 'c1',
      acquisition: 'fetched',
      code: null,
      itemId: 'i1',
      now: NOW,
    });
    expect(research.openCandidacyOf(db, 'i1')).toEqual({ researchId: 'r1', topic: '評測方法' });
    research.updateResearchStatus(db, 'r1', 'abandoned', NOW);
    expect(research.openCandidacyOf(db, 'i1')).toBeNull();
  });
});
