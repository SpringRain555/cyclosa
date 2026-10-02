/**
 * 抽進圖（整理的第一片，ADR-0033 S24）：從列清單、勾、抽、到復原，走真的服務與一個假的 Ollama。
 *
 * 假模型回的引文取自**這一次送來的正文開頭** —— 抽好幾份的時候每一份都要對得回自己的原文，
 * 不然 `locateQuote` 找不到、那一條不會寫進去，測試就量不到「真的抽進圖了」。
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

import { initDataRoot } from '../../src/application/bootstrap-service.js';
import { listUnextracted, startConsolidate } from '../../src/application/consolidate-service.js';
import { startResearch } from '../../src/application/research-service.js';
import { activeCount, cancel, cancelAll } from '../../src/application/run-registry.js';
import { createSampleCase } from '../../src/application/sample-service.js';
import { undoRun } from '../../src/application/undo-service.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import * as items from '../../src/infrastructure/db/repositories/item-repo.js';
import * as runs from '../../src/infrastructure/db/repositories/run-repo.js';

let server: Server;
let baseUrl = '';
let sandbox = '';
let root = '';
let slug = '';
let saved: string | undefined;
let calls = 0;
let holdAt = 0;
let held: ServerResponse | null = null;

async function inDb<T>(body: (db: DatabaseSync) => T): Promise<T> {
  const opened = await openCaseDatabase(join(root, 'cases', slug, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(opened.kind);
  try {
    return body(opened.db);
  } finally {
    opened.db.close();
  }
}

async function idle(): Promise<void> {
  await expect.poll(() => activeCount(), { timeout: 10_000 }).toBe(0);
}

async function listed(): Promise<string[]> {
  const view = await listUnextracted(root, slug);
  if (!view.ok) throw new Error(view.code);
  return view.data.items.map((entry) => entry.id);
}

/** 照資料庫算「應該列出哪幾份」：有正文的資料裡，沒有任何機器關聯拿它當出處的。 */
async function withoutMachineEvidence(): Promise<string[]> {
  return inDb((db) =>
    (
      db
        .prepare(
          `SELECT i.id FROM item i
            WHERE i.status = 'included' AND i.kind NOT IN ('reference','note')
              AND NOT EXISTS (SELECT 1 FROM edge_evidence ev JOIN edge e ON e.id = ev.edge_id
                               WHERE ev.item_id = i.id AND e.origin = 'machine')
            ORDER BY i.created_at, i.id`,
        )
        .all() as { id: string }[]
    ).map((row) => row.id),
  );
}

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') {
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'fake-extract',
              capabilities: ['completion'],
              details: { context_length: 128_000 },
            },
          ],
        }),
      );
      return;
    }
    if (req.url !== '/api/chat') {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      calls += 1;
      if (calls === holdAt) {
        held = res;
        return;
      }
      const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] };
      const user = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
      const text = /標題：[^\n]*\n\n([\s\S]*)\n<\/文件>$/.exec(user)?.[1] ?? '';
      const quote = text.trim().slice(0, 40);
      const extraction = {
        entities: [
          { name: '抽進圖甲', type: 'concept' },
          { name: '抽進圖乙', type: 'concept' },
        ],
        relations: [{ subject: '抽進圖甲', object: '抽進圖乙', rel: '測試關係', quote }],
      };
      res.end(JSON.stringify({ message: { content: JSON.stringify(extraction) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-consolidate-'));
  root = join(sandbox, 'data');
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'local');
  const configDir = join(sandbox, 'local', 'Cyclosa');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'providers.json'),
    JSON.stringify({
      version: 2,
      connections: { cli: null, ollama: { baseUrl, apiKeyEnv: null }, openai: null },
      tasks: Object.fromEntries(
        ['plan', 'find-sources', 'digest', 'extract', 'embed'].map((task) => [
          task,
          { via: 'ollama', model: 'fake-extract' },
        ]),
      ),
      diagnostics: { logModelCalls: false },
    }),
    'utf8',
  );
  calls = 0;
  holdAt = 0;
  held = null;
  expect((await initDataRoot(root)).ok).toBe(true);
  const sample = await createSampleCase(root);
  if (!sample.ok) throw new Error(JSON.stringify(sample));
  slug = sample.data.slug;
});

afterEach(async () => {
  cancelAll();
  held?.destroy();
  await idle();
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

it('清單只列還沒抽過的：有機器關聯拿它當出處的（v12 以前抽過的）不列；列清單不呼叫模型', async () => {
  const expected = await withoutMachineEvidence();
  expect(expected.length).toBeGreaterThan(1);
  const view = await listUnextracted(root, slug);
  if (!view.ok) throw new Error(view.code);
  expect(view.data.items.map((entry) => entry.id)).toEqual(expected);
  expect(view.data).toMatchObject({
    runId: null,
    researchOpen: false,
    extractService: { via: 'ollama', model: 'fake-extract', costs: false },
  });
  expect(view.data.items.every((entry) => entry.chars > 0)).toBe(true);
  expect(calls).toBe(0);
});

it('勾兩份抽進圖：一筆 consolidate 作業、走真抽取、標「抽過了」、從清單上消失', async () => {
  const picked = (await listed()).slice(0, 2);
  const started = await startConsolidate(root, slug, picked);
  expect(started.ok, JSON.stringify(started)).toBe(true);
  if (!started.ok) return;
  await idle();
  expect(calls).toBe(2);
  await inDb((db) => {
    const run = runs.getRun(db, started.data.runId)!;
    expect(run).toMatchObject({ kind: 'consolidate', label: '抽進圖', status: 'done', total: 2 });
    expect(run.requests).toBe(2);
    const runItems = runs.listRunItems(db, run.id);
    expect(runItems.map((entry) => entry.itemId).sort()).toEqual([...picked].sort());
    expect(runItems.every((entry) => entry.outcome === 'ok' && entry.newEdges > 0)).toBe(true);
    for (const id of picked) {
      expect(items.getItem(db, id)?.extractedBy).toBe('ollama:fake-extract');
    }
    const written = db
      .prepare("SELECT COUNT(*) AS n FROM edge WHERE run_id = ? AND origin = 'machine'")
      .get(run.id) as { n: number };
    expect(written.n).toBeGreaterThan(0);
  });
  const after = await listed();
  for (const id of picked) expect(after).not.toContain(id);
});

it('勾的不在清單上（已經抽過、空的）就整批不收，不開作業', async () => {
  const empty = await startConsolidate(root, slug, []);
  expect(empty).toMatchObject({ ok: false, code: 'CONSOLIDATE_SELECTION_INVALID' });
  const notArray = await startConsolidate(root, slug, 'abc');
  expect(notArray).toMatchObject({ ok: false, code: 'CONSOLIDATE_SELECTION_INVALID' });
  const extractedBefore = await inDb(
    (db) =>
      (
        db
          .prepare(
            `SELECT DISTINCT ev.item_id AS id FROM edge_evidence ev JOIN edge e ON e.id = ev.edge_id
              WHERE e.origin = 'machine' LIMIT 1`,
          )
          .get() as { id: string }
      ).id,
  );
  const fresh = (await listed())[0]!;
  const mixed = await startConsolidate(root, slug, [fresh, extractedBefore]);
  expect(mixed).toMatchObject({ ok: false, code: 'CONSOLIDATE_SELECTION_INVALID' });
  const kinds = await inDb((db) =>
    runs.listRuns(db, 50).filter((run) => run.kind === 'consolidate'),
  );
  expect(kinds).toEqual([]);
  expect(calls).toBe(0);
});

it('D4：研究沒結束不能抽；抽的作業在跑不能開研究、也不能再開一筆', async () => {
  const research = await startResearch(root, slug, { topic: '擋住整理' });
  expect(research.ok).toBe(true);
  const blocked = await startConsolidate(root, slug, (await listed()).slice(0, 1));
  expect(blocked).toMatchObject({ ok: false, code: 'CONSOLIDATE_RESEARCH_OPEN' });
  const view = await listUnextracted(root, slug);
  expect(view.ok && view.data.researchOpen).toBe(true);
});

it('D4 的另一半：抽的作業在跑時，開研究與再開一筆都被擋；取消之後剩下的標成已取消', async () => {
  holdAt = 1;
  const picked = (await listed()).slice(0, 2);
  const started = await startConsolidate(root, slug, picked);
  if (!started.ok) throw new Error(started.code);
  await expect.poll(() => calls, { timeout: 10_000 }).toBe(1);

  const research = await startResearch(root, slug, { topic: '這時候不能開' });
  expect(research).toMatchObject({ ok: false, code: 'CONSOLIDATE_RUNNING' });
  const again = await startConsolidate(root, slug, picked.slice(1));
  expect(again).toMatchObject({ ok: false, code: 'CONSOLIDATE_RUNNING' });
  const view = await listUnextracted(root, slug);
  expect(view.ok && view.data.runId).toBe(started.data.runId);

  cancel(started.data.runId);
  held?.destroy();
  await idle();
  await inDb((db) => {
    const run = runs.getRun(db, started.data.runId)!;
    expect(run.status).toBe('cancelled');
    const outcomes = runs.listRunItems(db, run.id).map((entry) => entry.outcome);
    expect(outcomes).toContain('cancelled');
    for (const id of picked) expect(items.getItem(db, id)?.extractedAt).toBeNull();
  });
  // 取消之後兩份都還沒抽過，所以都還在清單上。
  const after = await listed();
  for (const id of picked) expect(after).toContain(id);
});

it('復原那一筆：抽出來的關聯刪掉，「抽過了」清回去，那幾份回到清單上', async () => {
  const picked = (await listed()).slice(0, 2);
  const started = await startConsolidate(root, slug, picked);
  if (!started.ok) throw new Error(started.code);
  await idle();
  for (const id of picked) expect(await listed()).not.toContain(id);

  const undone = await undoRun(root, slug, started.data.runId);
  expect(undone.ok, JSON.stringify(undone)).toBe(true);
  if (!undone.ok) return;
  expect(undone.data.deletedEdges).toBeGreaterThan(0);
  expect(undone.data.deletedItems).toBe(0);
  await inDb((db) => {
    for (const id of picked) {
      expect(items.getItem(db, id)).toMatchObject({ extractedAt: null, extractedBy: null });
    }
  });
  const after = await listed();
  for (const id of picked) expect(after).toContain(id);
});
