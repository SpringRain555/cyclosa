import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import * as ops from '../../src/infrastructure/db/repositories/consolidate-op-repo.js';
import { insertEntity } from '../../src/infrastructure/db/repositories/entity-repo.js';
import { insertNote } from '../../src/infrastructure/db/repositories/note-repo.js';

let folder: string;
let db: DatabaseSync;

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'cyclosa-consolidate-repo-'));
  const opened = await openCaseDatabase(join(folder, 'case.sqlite'), { create: true });
  if (opened.kind !== 'ok') throw new Error(opened.kind);
  db = opened.db;
});

afterEach(async () => {
  db.close();
  await rm(folder, { recursive: true, force: true });
});

function item(id: string, status = 'included'): void {
  db.prepare(
    `INSERT INTO item (id, kind, title, status, created_at, updated_at)
     VALUES (?, 'text', ?, ?, 1, 1)`,
  ).run(id, `合成資料 ${id}`, status);
}

function edge(
  id: string,
  sourceId: string,
  sourceKind: 'item' | 'entity',
  targetId: string,
  targetKind: 'item' | 'entity',
  now = 1,
): void {
  db.prepare(
    `INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind,
     origin, status, created_at, updated_at)
     VALUES (?, 'named', ?, ?, ?, ?, ?, 'machine', 'pending', ?, ?)`,
  ).run(id, id, sourceId, sourceKind, targetId, targetKind, now, now);
}

function evidence(id: string, edgeId: string, itemId: string): void {
  db.prepare(
    `INSERT INTO edge_evidence (id, edge_id, item_id, quote, char_start, char_end, created_at)
     VALUES (?, ?, ?, ?, 0, 2, 1)`,
  ).run(id, edgeId, itemId, `合成引文 ${id}`);
}

describe('整理規劃上下文的查詢', () => {
  it('空專題回空清單與零，不補造上下文', () => {
    expect([...ops.entityMentionCounts(db)]).toEqual([]);
    expect(ops.listSingleEvidenceEdges(db, 100)).toEqual([]);
    expect(ops.countSingleEvidenceEdges(db)).toBe(0);
    expect(ops.listNoteBodies(db)).toEqual([]);
    expect(ops.listItemIds(db)).toEqual([]);
  });

  it('提及數兩個方向都算，同一資料多條邊只算一次', () => {
    item('a');
    item('b');
    for (const id of ['e1', 'e2', 'unused']) {
      insertEntity(db, { id, name: `合成實體 ${id}`, type: 'concept', now: 1 });
    }
    edge('forward', 'e1', 'entity', 'a', 'item');
    edge('backward', 'a', 'item', 'e1', 'entity');
    edge('duplicate', 'e1', 'entity', 'a', 'item');
    edge('other-item', 'b', 'item', 'e1', 'entity');
    edge('other-entity', 'e2', 'entity', 'a', 'item');
    edge('entities', 'e1', 'entity', 'e2', 'entity');
    edge('items', 'a', 'item', 'b', 'item');
    expect([...ops.entityMentionCounts(db)]).toEqual([
      ['e1', 2],
      ['e2', 1],
    ]);
  });

  it('單一出處按資料去重，取固定引文、名稱與順序；總數不受截斷影響', () => {
    item('a');
    item('b');
    insertEntity(db, { id: 'e1', name: '合成實體甲', type: 'concept', now: 1 });
    edge('older', 'e1', 'entity', 'a', 'item', 1);
    edge('newer-a', 'a', 'item', 'e1', 'entity', 2);
    edge('newer-b', 'a', 'item', 'b', 'item', 2);
    edge('multiple-items', 'e1', 'entity', 'b', 'item', 3);
    edge('without-evidence', 'b', 'item', 'e1', 'entity', 4);
    evidence('z-older', 'older', 'a');
    evidence('a-older', 'older', 'a');
    evidence('new-a', 'newer-a', 'a');
    evidence('new-b', 'newer-b', 'b');
    evidence('multi-a', 'multiple-items', 'a');
    evidence('multi-b', 'multiple-items', 'b');
    expect(ops.countSingleEvidenceEdges(db)).toBe(3);
    expect(ops.listSingleEvidenceEdges(db, 1)).toEqual([
      {
        id: 'newer-a',
        source: '合成資料 a',
        target: '合成實體甲',
        rel: 'newer-a',
        itemId: 'a',
        quote: '合成引文 new-a',
      },
    ]);
    const all = ops.listSingleEvidenceEdges(db, 100);
    expect(all.map((row) => row.id)).toEqual(['newer-a', 'newer-b', 'older']);
    expect(all[2]).toEqual({
      id: 'older',
      source: '合成實體甲',
      target: '合成資料 a',
      rel: 'older',
      itemId: 'a',
      quote: '合成引文 a-older',
    });
  });

  it('筆記保留原文並依建立時間與識別碼排序；識別碼清單也包含筆記與已排除資料', () => {
    item('included');
    item('excluded', 'excluded');
    for (const [id, now] of [
      ['later', 2],
      ['early-b', 1],
      ['early-a', 1],
    ] as const) {
      insertNote(db, {
        id,
        itemId: 'included',
        title: '合成筆記',
        body: `合成正文 ${id}`,
        selectorJson: '[]',
        snapshotSha256: null,
        anchorOk: true,
        now,
      });
    }
    expect(ops.listNoteBodies(db)).toEqual([
      { id: 'early-a', body: '合成正文 early-a' },
      { id: 'early-b', body: '合成正文 early-b' },
      { id: 'later', body: '合成正文 later' },
    ]);
    expect([...ops.listItemIds(db)].sort()).toEqual([
      'early-a',
      'early-b',
      'excluded',
      'included',
      'later',
    ]);
  });
});

describe('單一獨立來源的具名關聯', () => {
  function setup() {
    for (const id of ['a', 'b', 'c', 'middle']) item(id);
    edge('named', 'a', 'item', 'b', 'item');
    evidence('ev-a', 'named', 'a');
  }
  it('同份資料多段引文仍只列一次', () => {
    setup();
    evidence('ev-again', 'named', 'a');
    expect(ops.listSingleEvidenceEdges(db, 100).map((row) => row.id)).toEqual(['named']);
  });
  it('不同資料屬於同一轉載群仍是一個獨立來源', () => {
    setup();
    evidence('ev-b', 'named', 'b');
    edge('derived', 'a', 'item', 'b', 'item');
    db.prepare("UPDATE edge SET layer='derived' WHERE id='derived'").run();
    expect(ops.countSingleEvidenceEdges(db)).toBe(1);
  });
  it('轉載群可經未提供出處的中間資料連通', () => {
    setup();
    evidence('ev-b', 'named', 'b');
    edge('derived1', 'a', 'item', 'middle', 'item');
    edge('derived2', 'middle', 'item', 'b', 'item');
    db.prepare("UPDATE edge SET layer='derived' WHERE id LIKE 'derived%'").run();
    expect(ops.listSingleEvidenceEdges(db, 100).map((row) => row.id)).toEqual(['named']);
    evidence('ev-c', 'named', 'c');
    expect(ops.countSingleEvidenceEdges(db)).toBe(0);
  });
  it('否決與非具名關聯不列；人工已確認的具名關聯可列', () => {
    setup();
    db.prepare("UPDATE edge SET status='rejected' WHERE id='named'").run();
    expect(ops.countSingleEvidenceEdges(db)).toBe(0);
    db.prepare("UPDATE edge SET status='pending',layer='comention' WHERE id='named'").run();
    expect(ops.countSingleEvidenceEdges(db)).toBe(0);
    db.prepare(
      "UPDATE edge SET layer='named',origin='human',status='confirmed' WHERE id='named'",
    ).run();
    expect(ops.countSingleEvidenceEdges(db)).toBe(1);
  });
  it('清單查詢不改寫關聯、出處或裁決', () => {
    setup();
    const before = db.prepare('SELECT * FROM edge').all();
    const ev = db.prepare('SELECT * FROM edge_evidence').all();
    ops.listSingleEvidenceEdges(db, 100);
    ops.countSingleEvidenceEdges(db);
    expect(db.prepare('SELECT * FROM edge').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM edge_evidence').all()).toEqual(ev);
  });
});
