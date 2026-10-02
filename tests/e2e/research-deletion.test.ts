import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { deleteResearch, type ResearchDeletion } from '../../src/application/research-service.js';
import { register, unregister } from '../../src/application/run-registry.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import * as research from '../../src/infrastructure/db/repositories/research-repo.js';
import { writeSyntheticGraph } from '../../tools/dev/graph-fixture.js';

let sandbox: string;
let root: string;
let folder: string;
let slug: string;
let app: FastifyInstance;
let saved: string | undefined;

async function inDb<T>(body: (db: DatabaseSync) => T): Promise<T> {
  const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(opened.kind);
  try {
    return body(opened.db);
  } finally {
    opened.db.close();
  }
}

function seedResearch(db: DatabaseSync, id: string): void {
  research.insertResearch(db, {
    id,
    kind: 'research',
    topic: id,
    hitsJson: '[]',
    correlationId: id,
    now: 1,
  });
  research.insertMessage(db, {
    id: `${id}-message`,
    researchId: id,
    ord: 0,
    role: 'model',
    content: '合成對話',
    now: 1,
  });
  research.insertDirection(db, {
    id: `${id}-direction`,
    researchId: id,
    ord: 0,
    title: '合成方向',
    what: '',
    expect: '',
    keywords: [],
    origin: 'model',
    adopted: true,
    now: 1,
  });
  research.addCandidate(db, {
    id: `${id}-candidate`,
    researchId: id,
    directionId: `${id}-direction`,
    url: `https://example.invalid/${id}`,
    title: '合成候選',
    why: '',
    bib: { authors: '', year: '', venue: '' },
    expectedAccess: 'unknown',
    acquisition: 'fetched',
    now: 1,
  });
  research.setGap(db, id, '{"opinion":"合成意見"}', 1);
  research.updateResearchStatus(db, id, 'done', 2);
}

async function retained() {
  return inDb((db) => ({
    items: db.prepare('SELECT * FROM item ORDER BY id').all(),
    entities: db.prepare('SELECT * FROM entity ORDER BY id').all(),
    edges: db.prepare('SELECT * FROM edge ORDER BY id').all(),
    evidence: db.prepare('SELECT * FROM edge_evidence ORDER BY id').all(),
    notes: db.prepare('SELECT * FROM note ORDER BY id').all(),
    runItems: db.prepare('SELECT * FROM run_item ORDER BY id').all(),
    otherResearch: research.getResearch(db, 'other'),
    otherMessages: research.listMessages(db, 'other'),
    otherDirections: research.listDirections(db, 'other'),
    otherCandidates: research.listCandidates(db, 'other'),
  }));
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-delete-research-'));
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'LocalAppData');
  root = join(sandbox, 'data');
  app = (await buildServer()).app;
  await app.ready();
  await app.inject({ method: 'POST', url: '/api/system/data-root', payload: { dataRoot: root } });
  const created = await app.inject({
    method: 'POST',
    url: '/api/cases',
    payload: { name: '刪除研究驗收' },
  });
  slug = (created.json() as { data: { slug: string } }).data.slug;
  folder = join(root, 'cases', slug);
  await inDb((db) => {
    writeSyntheticGraph(db, 1);
    seedResearch(db, 'target');
    seedResearch(db, 'other');
    db.exec(`
      INSERT INTO run (id, kind, status, research_id, correlation_id, created_at)
      VALUES ('collect', 'research', 'done', 'target', 'collect', 1),
             ('build', 'research', 'done', 'target', 'build', 1);
      UPDATE item SET run_id = 'collect';
      UPDATE edge SET run_id = 'build';
      INSERT INTO run_item (id, run_id, requested, item_id, outcome, new_edges)
      VALUES ('built-item', 'build', '合成資料', 'itm-focus', 'ok', 1);
      INSERT INTO item (id, kind, title, status, created_at, updated_at)
      VALUES ('annotation', 'note', '合成點註', 'included', 1, 1);
      INSERT INTO note (id, item_id, body, created_at, updated_at)
      VALUES ('annotation', 'itm-focus', '合成點註內文', 1, 1);
    `);
    research.setBuildRun(db, 'target', 'build', 2);
  });
  await mkdir(join(folder, 'model-calls'), { recursive: true });
  for (const id of ['target', 'collect', 'build', 'other']) {
    await writeFile(join(folder, 'model-calls', `${id}.jsonl`), `${id}\n`, 'utf8');
  }
  for (const name of ['sources', 'derived']) {
    await mkdir(join(folder, name), { recursive: true });
    for (const origin of ['fetched', 'uploaded']) {
      await writeFile(join(folder, name, `${origin}.txt`), origin, 'utf8');
    }
  }
});

afterEach(async () => {
  unregister('build');
  await app?.close();
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

it('預覽列兩張清單、不刪任何紀錄；確認只刪這次研究列出的內容', async () => {
  const before = await retained();
  const url = `/api/cases/${slug}/research/target`;
  const response = await app.inject({ method: 'DELETE', url });
  expect(response.statusCode).toBe(200);
  const preview = (response.json() as { data: ResearchDeletion }).data;
  expect(preview).toEqual({
    id: 'target',
    topic: 'target',
    done: false,
    willDelete: ['conversation', 'plan', 'directions', 'candidates', 'gap', 'modelCalls'],
    willKeep: ['fetched', 'uploaded', 'graph', 'runs'],
  });
  const targetBefore = await inDb((db) => ({
    research: research.getResearch(db, 'target'),
    messages: research.listMessages(db, 'target'),
    directions: research.listDirections(db, 'target'),
    candidates: research.listCandidates(db, 'target'),
  }));
  expect(targetBefore.research).not.toBeNull();
  expect(targetBefore.messages).toHaveLength(1);
  expect(targetBefore.directions).toHaveLength(1);
  expect(targetBefore.candidates).toHaveLength(1);
  for (const confirm of [false, 'true', 1]) {
    const response = await app.inject({ method: 'DELETE', url, payload: { confirm } });
    expect((response.json() as { data: ResearchDeletion }).data.done).toBe(false);
  }
  expect(await readdir(join(folder, 'model-calls'))).toHaveLength(4);
  expect(await retained()).toEqual(before);
  const runsBefore = await inDb((db) => db.prepare('SELECT * FROM run ORDER BY id').all());
  const confirmed = await app.inject({ method: 'DELETE', url, payload: { confirm: true } });
  expect((confirmed.json() as { data: ResearchDeletion }).data).toEqual({ ...preview, done: true });
  await inDb((db) => {
    expect(research.getResearch(db, 'target')).toBeNull();
    expect(research.listMessages(db, 'target')).toEqual([]);
    expect(research.listDirections(db, 'target')).toEqual([]);
    expect(research.listCandidates(db, 'target')).toEqual([]);
    expect(db.prepare('SELECT * FROM run ORDER BY id').all()).toEqual(
      runsBefore.map((entry) => ({ ...entry, research_id: null })),
    );
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
  expect(await retained()).toEqual(before);
  expect(await readdir(join(folder, 'model-calls'))).toEqual(['other.jsonl']);
  expect(await readFile(join(folder, 'model-calls', 'other.jsonl'), 'utf8')).toBe('other\n');
  for (const name of ['sources', 'derived']) {
    for (const origin of ['fetched', 'uploaded']) {
      expect(await readFile(join(folder, name, `${origin}.txt`), 'utf8')).toBe(origin);
    }
  }
});

it('預覽與確認都擋下非終態，以及還在收尾的建圖作業', async () => {
  await inDb((db) => research.updateResearchStatus(db, 'target', 'building', 3));
  for (const confirm of [false, true]) {
    expect(await deleteResearch(root, slug, 'target', confirm)).toMatchObject({
      ok: false,
      code: 'RESEARCH_STEP_INVALID',
    });
  }
  await inDb((db) => research.updateResearchStatus(db, 'target', 'abandoned', 4));
  register('build');
  for (const confirm of [false, true]) {
    expect(await deleteResearch(root, slug, 'target', confirm)).toMatchObject({
      ok: false,
      code: 'RESEARCH_STEP_INVALID',
    });
  }
  expect(await inDb((db) => research.getResearch(db, 'target'))).not.toBeNull();
});

it('沒開診斷也能先預覽再確認，重複確認回找不到研究', async () => {
  await rm(join(folder, 'model-calls'), { recursive: true, force: true });
  expect(await deleteResearch(root, slug, 'target')).toMatchObject({
    ok: true,
    data: { done: false },
  });
  expect(await deleteResearch(root, slug, 'target', true)).toMatchObject({
    ok: true,
    data: { done: true },
  });
  expect(await deleteResearch(root, slug, 'target', true)).toMatchObject({
    ok: false,
    code: 'RESEARCH_NOT_FOUND',
  });
});
