import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
let sandbox: string;
let app: FastifyInstance;
let saved: string | undefined;
let slug: string;
let root: string;
beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-single-source-'));
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'local');
  await mkdir(process.env['LOCALAPPDATA'], { recursive: true });
  root = join(sandbox, 'data');
  app = (await buildServer()).app;
  await app.ready();
  const setup = await app.inject({
    method: 'POST',
    url: '/api/system/data-root',
    payload: { dataRoot: root },
  });
  expect(setup.json().ok).toBe(true);
  const created = await app.inject({
    method: 'POST',
    url: '/api/cases',
    payload: { name: '虛構資料單一來源' },
  });
  slug = created.json().data.slug;
});
afterEach(async () => {
  await app?.close();
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});
it('未開規劃或設定模型即可讀空清單，未知專題不會被建立', async () => {
  const result = await app.inject({
    method: 'GET',
    url: `/api/cases/${encodeURIComponent(slug)}/consolidate/single-source-relations`,
  });
  expect(result.json()).toMatchObject({ ok: true, data: { entries: [], total: 0 } });
  const missing = await app.inject({
    method: 'GET',
    url: '/api/cases/not-present/consolidate/single-source-relations',
  });
  expect(missing.json().ok).toBe(false);
});
it('清單與截斷數一致，名稱與焦點可供跳轉；重查反映新裁決且不開整理作業', async () => {
  const opened = await openCaseDatabase(join(root, 'cases', slug, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(opened.kind);
  const db = opened.db;
  try {
    db.prepare(
      "INSERT INTO item(id,kind,title,status,created_at,updated_at) VALUES('a','text','虛構來源','included',1,1),('b','text','虛構對象','included',1,1)",
    ).run();
    for (let i = 0; i < 102; i++) {
      const id = `e-${String(i).padStart(3, '0')}`;
      db.prepare(
        "INSERT INTO edge(id,layer,rel,source_id,source_kind,target_id,target_kind,origin,status,created_at,updated_at) VALUES(?,'named','支持','a','item','b','item','human','pending',?,1)",
      ).run(id, i);
      db.prepare(
        "INSERT INTO edge_evidence(id,edge_id,item_id,quote,char_start,char_end,created_at) VALUES(?,?,'a',?,0,600,1)",
      ).run(id, id, '甲'.repeat(600));
    }
    const url = `/api/cases/${encodeURIComponent(slug)}/consolidate/single-source-relations`;
    const result = (await app.inject({ method: 'GET', url })).json().data;
    expect(result.total).toBe(102);
    expect(result.entries).toHaveLength(100);
    const next = (
      await app.inject({ method: 'GET', url: url + '?after=' + result.nextCursor })
    ).json().data;
    expect(next.entries).toHaveLength(2);
    expect(next.nextCursor).toBeNull();
    expect(
      new Set([...result.entries, ...next.entries].map((row: { id: string }) => row.id)).size,
    ).toBe(102);
    expect(result.entries[0]).toMatchObject({
      id: 'e-101',
      source: '虛構來源',
      target: '虛構對象',
      itemTitle: '虛構來源',
      focusId: 'a',
    });
    expect(result.entries[0].quote).toHaveLength(500);
    expect(db.prepare('SELECT COUNT(*) AS n FROM research').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM run').get()).toMatchObject({ n: 0 });
    db.prepare("UPDATE edge SET status='rejected' WHERE id='e-101'").run();
    const updated = (await app.inject({ method: 'GET', url })).json().data;
    expect(updated.total).toBe(101);
    expect(updated.entries.some((row: { id: string }) => row.id === 'e-101')).toBe(false);
  } finally {
    db.close();
  }
});
