import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { applyMigration } from '../../src/infrastructure/db/database.js';
import { insertEntity } from '../../src/infrastructure/db/repositories/entity-repo.js';
import {
  evidenceRows,
  findByTriple,
  setStatus,
} from '../../src/infrastructure/db/repositories/edge-repo.js';
import { executeAddEdgeOperation } from '../../src/application/consolidate-ops/add-edge.js';
import { scoreFor } from '../../src/domain/graph/index.js';
import {
  edgeSnapshot,
  undoAddedEvidence,
} from '../../src/infrastructure/db/repositories/consolidate-edge-undo-repo.js';
import { insertResearch } from '../../src/infrastructure/db/repositories/research-repo.js';
import {
  insertOp,
  setState,
} from '../../src/infrastructure/db/repositories/consolidate-op-repo.js';

let db: DatabaseSync;
const quote = '虛構機構甲支持虛構機構乙的研究。';
const payload = { source: 'a', target: 'b', rel: '支持', itemId: 'body', quote };

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  const folder = new URL('../../src/infrastructure/db/migrations/', import.meta.url);
  for (const file of (await readdir(folder)).filter((name) => name.endsWith('.sql')).sort())
    applyMigration(db, await readFile(new URL(file, folder), 'utf8'), Number(file.slice(0, 3)));
  db.exec(
    "INSERT INTO run (id,kind,status,correlation_id,created_at) VALUES ('run','consolidate','done','fixture',1)",
  );
  db.exec(
    "INSERT INTO item (id,kind,status,created_at,updated_at) VALUES ('body','text','included',1,1)",
  );
  db.exec(
    "INSERT INTO item (id,kind,status,created_at,updated_at) VALUES ('other','text','included',1,1)",
  );
  insertEntity(db, { id: 'a', name: '虛構機構甲', type: 'org', now: 1 });
  insertEntity(db, { id: 'b', name: '虛構機構乙', type: 'org', now: 1 });
});
afterEach(() => db.close());

function execute(text = quote, itemId = 'body') {
  return executeAddEdgeOperation({
    db,
    runId: 'run',
    itemId,
    text,
    extraction: {
      entities: [],
      relations: [],
      dropped: { unknownEntity: 0, selfRelation: 0, duplicate: 0 },
    },
    addEdge: { ...payload, itemId },
  });
}

it('引文由正文定位，建立待查證具名關聯並沿用可信度', () => {
  expect(execute('前言。' + quote)).toEqual({ newEdges: 1, code: null });
  const edge = findByTriple(db, payload);
  expect(edge).toMatchObject({
    status: 'pending',
    layer: 'named',
    origin: 'machine',
    confidence: scoreFor({ independentSourceCount: 1, hasDirectQuote: true }),
  });
  expect(evidenceRows(db, edge!.id)).toMatchObject([
    { itemId: 'body', quote, charStart: 3, charEnd: 3 + quote.length },
  ]);
});

it('找不到引文時不建立任何關聯或出處', () => {
  expect(execute('這是完全無關的虛構正文。')).toEqual({
    newEdges: 0,
    code: 'PROVIDER_QUOTE_NOT_FOUND',
  });
  expect(db.prepare('SELECT * FROM edge').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM edge_evidence').all()).toEqual([]);
});

it('同一出處撞到否決墓碑時不重提', () => {
  execute();
  const edge = findByTriple(db, payload)!;
  setStatus(db, edge.id, 'rejected', 2);
  expect(execute()).toEqual({ newEdges: 0, code: 'GRAPH_TOMBSTONED' });
  expect(findByTriple(db, payload)?.status).toBe('rejected');
  expect(evidenceRows(db, edge.id)).toHaveLength(1);
});

it('新的來源沿用墓碑例外，回到待查證而非自動確認', () => {
  execute();
  const edge = findByTriple(db, payload)!;
  setStatus(db, edge.id, 'rejected', 2);
  expect(execute(quote, 'other')).toEqual({ newEdges: 1, code: null });
  expect(findByTriple(db, payload)).toMatchObject({ status: 'pending', previouslyRejected: true });
  expect(evidenceRows(db, edge.id)).toHaveLength(2);
});

it('執行前來源遭排除時不寫入', () => {
  db.prepare("UPDATE item SET status='excluded' WHERE id='body'").run();
  expect(execute()).toEqual({ newEdges: 0, code: 'CONSOLIDATE_OP_STALE' });
  expect(findByTriple(db, payload)).toBeNull();
});

function recordSupplement(): string {
  execute();
  const id = findByTriple(db, payload)!.id;
  const before = edgeSnapshot(db, id);
  execute(quote, 'other');
  insertResearch(db, {
    id: 'shell',
    kind: 'consolidate',
    topic: null,
    hitsJson: '[]',
    correlationId: 'fixture',
    now: 1,
  });
  insertOp(db, {
    id: 'op',
    researchId: 'shell',
    ord: 0,
    kind: 'add-edge',
    payloadJson: JSON.stringify({ ...payload, itemId: 'other' }),
    why: '虛構測試',
  });
  setState(db, {
    id: 'op',
    state: 'done',
    runId: 'run',
    undoJson: JSON.stringify({ edgeId: id, before, after: edgeSnapshot(db, id) }),
    executedAt: 3,
  });
  return id;
}

it('補到既有關聯的出處能還原，重複復原不重做', () => {
  const id = recordSupplement();
  expect(evidenceRows(db, id)).toHaveLength(2);
  expect(undoAddedEvidence(db, 'run').size).toBe(0);
  expect(evidenceRows(db, id).map((entry) => entry.itemId)).toEqual(['body']);
  expect(undoAddedEvidence(db, 'run').size).toBe(0);
  expect(evidenceRows(db, id)).toHaveLength(1);
});

it('補出處後又被修改的關聯不覆寫，回報保留', () => {
  const id = recordSupplement();
  setStatus(db, id, 'confirmed', Date.now() + 1);
  expect(undoAddedEvidence(db, 'run').size).toBe(1);
  expect(findByTriple(db, payload)?.status).toBe('confirmed');
  expect(evidenceRows(db, id)).toHaveLength(2);
});
