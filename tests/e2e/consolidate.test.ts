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
import {
  executeConsolidateShell,
  planConsolidateShell,
  setConsolidateOpChecked,
  startConsolidateShell,
} from '../../src/application/consolidate-ops-service.js';
import { startResearch } from '../../src/application/research-service.js';
import { activeCount, cancel, cancelAll } from '../../src/application/run-registry.js';
import { createSampleCase } from '../../src/application/sample-service.js';
import { undoRun } from '../../src/application/undo-service.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import { removeDerived, readDerived } from '../../src/infrastructure/fs/case-files.js';
import { insertEntity, getEntity } from '../../src/infrastructure/db/repositories/entity-repo.js';
import {
  findByTriple,
  evidenceRows,
  setStatus,
  appendAudit,
} from '../../src/infrastructure/db/repositories/edge-repo.js';
import type { ConsolidateOpDraft } from '../../src/domain/research/consolidate.js';
import * as items from '../../src/infrastructure/db/repositories/item-repo.js';
import * as runs from '../../src/infrastructure/db/repositories/run-repo.js';
import * as consolidateOps from '../../src/infrastructure/db/repositories/consolidate-op-repo.js';
import * as researchRows from '../../src/infrastructure/db/repositories/research-repo.js';
import * as entities from '../../src/infrastructure/db/repositories/entity-repo.js';

let server: Server;
let baseUrl = '';
let sandbox = '';
let root = '';
let slug = '';
let saved: string | undefined;
let calls = 0;
let holdAt = 0;
let held: ServerResponse | null = null;
let includeMerge = false;
let mergedAtExtract: string | null = null;
let proposedOperations: readonly ConsolidateOpDraft[] | null = null;

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
    if (req.url === '/api/embed') {
      let text = '';
      req.on('data', (chunk: Buffer) => {
        text += chunk.toString();
      });
      req.on('end', () => {
        const body = JSON.parse(text) as { input: string[] };
        res.end(JSON.stringify({ embeddings: body.input.map(() => [1, 0]) }));
      });
      return;
    }
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
    req.on('end', async () => {
      calls += 1;
      if (calls === holdAt) {
        held = res;
        return;
      }
      const parsed = JSON.parse(body) as { messages: { role: string; content: string }[] };
      const user = parsed.messages.find((m) => m.role === 'user')?.content ?? '';
      const system = parsed.messages.find((m) => m.role === 'system')?.content ?? '';
      if (system.includes('專題資料整理的規劃助手')) {
        const context = JSON.parse(user) as {
          unextracted: { id: string }[];
          mergeCandidates: { keep: string; drop: string }[];
        };
        const itemIds = context.unextracted.slice(0, 2).map((entry) => entry.id);
        res.end(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                operations: proposedOperations ?? [
                  ...itemIds.map((itemId) => ({
                    kind: 'extract',
                    payload: { itemIds: [itemId] },
                    why: '合成規劃建議抽取這份未整理資料',
                  })),
                  ...(includeMerge
                    ? context.mergeCandidates
                        .filter((pair) => pair.keep === 'merge-a' && pair.drop === 'merge-b')
                        .map((pair) => ({
                          kind: 'merge',
                          payload: { keep: pair.keep, drop: pair.drop },
                          why: '合成合併提案',
                        }))
                    : []),
                ],
              }),
            },
          }),
        );
        return;
      }
      const separator = String.fromCharCode(10);
      if (includeMerge)
        mergedAtExtract = await inDb((db) => entities.getEntity(db, 'merge-b')?.mergedInto ?? null);
      const textStart = user.indexOf(separator + separator);
      const textEnd = user.lastIndexOf(separator + '</文件>');
      const text =
        textStart >= 0 && textEnd > textStart ? user.slice(textStart + 2, textEnd) : user;
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
  includeMerge = false;
  mergedAtExtract = null;
  proposedOperations = null;
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

it('整理殼：plan 提案預設不勾，執行前逐項 stale，部分失敗仍完成；復原清掉本次 extracted_at', async () => {
  const opened = await startConsolidateShell(root, slug);
  expect(opened.ok, JSON.stringify(opened)).toBe(true);
  if (!opened.ok) return;
  const planned = await planConsolidateShell(root, slug, opened.data.id);
  expect(planned.ok, JSON.stringify(planned)).toBe(true);
  if (!planned.ok) return;
  expect(planned.data.status).toBe('reviewing');
  const suggestions = planned.data.operations.filter((operation) => operation.kind === 'extract');
  expect(suggestions).toHaveLength(2);
  expect(suggestions.every((operation) => operation.checked === false)).toBe(true);
  for (const operation of suggestions) {
    expect((await setConsolidateOpChecked(root, slug, opened.data.id, operation.id, true)).ok).toBe(
      true,
    );
  }
  const payload = suggestions.map((operation) => operation.payload as { itemIds: string[] });
  const staleId = payload[0]?.itemIds[0];
  const freshId = payload[1]?.itemIds[0];
  if (staleId === undefined || freshId === undefined) throw new Error('missing seeded item id');
  await inDb((db) =>
    items.setItemExtracted(db, { id: staleId, extractedBy: 'another operation', now: Date.now() }),
  );
  const started = await executeConsolidateShell(root, slug, opened.data.id);
  expect(started.ok, JSON.stringify(started)).toBe(true);
  if (!started.ok) return;
  await idle();
  expect(calls).toBe(2);
  await inDb((db) => {
    expect(runs.getRun(db, started.data.runId)).toMatchObject({
      kind: 'consolidate',
      researchId: opened.data.id,
      status: 'partial',
      total: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(researchRows.getResearch(db, opened.data.id)?.status).toBe('done');
    const rows = consolidateOps.listOps(db, opened.data.id);
    expect(rows.map((operation) => operation.state).sort()).toEqual(['done', 'stale']);
    expect(rows.find((operation) => operation.code === 'CONSOLIDATE_OP_STALE')).toBeDefined();
    expect(items.getItem(db, freshId)?.extractedAt).not.toBeNull();
  });
  const undone = await undoRun(root, slug, started.data.runId);
  expect(undone.ok, JSON.stringify(undone)).toBe(true);
  await inDb((db) => {
    expect(items.getItem(db, staleId)?.extractedAt).not.toBeNull();
    expect(items.getItem(db, freshId)?.extractedAt).toBeNull();
  });
});

it('整理殼開啟時會擋住不開殼的抽進圖與新研究', async () => {
  const opened = await startConsolidateShell(root, slug);
  expect(opened.ok).toBe(true);
  const blockedExtraction = await startConsolidate(root, slug, (await listed()).slice(0, 1));
  expect(blockedExtraction).toMatchObject({ ok: false, code: 'CONSOLIDATE_RESEARCH_OPEN' });
  const blockedResearch = await startResearch(root, slug, { topic: '整理殼開啟時不能建立研究' });
  expect(blockedResearch).toMatchObject({ ok: false, code: 'RESEARCH_ALREADY_OPEN' });
  expect(calls).toBe(0);
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

it.each(['excluded', 'missing-body', 'already-extracted'] as const)(
  '不開殼的抽進圖：執行前變成 %s，沿用 PARSE_EMPTY_CONTENT 並繼續結算',
  async (change) => {
    holdAt = 1;
    const picked = (await listed()).slice(0, 2);
    expect(picked).toHaveLength(2);
    const changedId = picked[1]!;
    const started = await startConsolidate(root, slug, picked);
    if (!started.ok) throw new Error(started.code);
    await expect.poll(() => held !== null, { timeout: 10_000 }).toBe(true);
    // 第一份等待模型時改變第二份，確保它是在開始作業後才失去資格。
    if (change === 'missing-body') {
      await removeDerived(join(root, 'cases', slug), changedId);
    } else {
      await inDb((db) => {
        if (change === 'excluded') items.setStatus(db, changedId, 'excluded', Date.now());
        else items.setItemExtracted(db, { id: changedId, extractedBy: 'fixture', now: Date.now() });
      });
    }
    held?.end(
      JSON.stringify({ message: { content: JSON.stringify({ entities: [], relations: [] }) } }),
    );
    await idle();
    expect(calls).toBe(1);
    await inDb((db) => {
      expect(runs.getRun(db, started.data.runId)).toMatchObject({
        researchId: null,
        status: 'partial',
        succeeded: 1,
        failed: 1,
      });
      expect(
        runs.listRunItems(db, started.data.runId).find((entry) => entry.itemId === changedId),
      ).toMatchObject({
        outcome: 'failed',
        code: 'PARSE_EMPTY_CONTENT',
      });
    });
  },
);

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
  const shellBlocked = await startConsolidateShell(root, slug);
  expect(shellBlocked).toMatchObject({ ok: false, code: 'CONSOLIDATE_RUNNING' });
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

it('同一筆整理混合合併與抽取：模型先列抽取也仍先合併，再共用抽取管線', async () => {
  includeMerge = true;
  await inDb((db) => {
    entities.insertEntity(db, { id: 'merge-a', name: '合成測試中心', type: 'org', now: 1 });
    entities.insertEntity(db, { id: 'merge-b', name: '合成測試中芯', type: 'org', now: 1 });
  });
  const opened = await startConsolidateShell(root, slug);
  if (!opened.ok) throw new Error(opened.code);
  const planned = await planConsolidateShell(root, slug, opened.data.id);
  if (!planned.ok) throw new Error(planned.code);
  expect(planned.data.operations.map((op) => op.kind)).toEqual(['merge', 'extract', 'extract']);
  for (const op of planned.data.operations) {
    expect((await setConsolidateOpChecked(root, slug, opened.data.id, op.id, true)).ok).toBe(true);
  }
  const started = await executeConsolidateShell(root, slug, opened.data.id);
  if (!started.ok) throw new Error(started.code);
  await idle();
  expect(mergedAtExtract).toBe('merge-a');
  await inDb((db) => {
    expect(runs.getRun(db, started.data.runId)).toMatchObject({ total: 3, status: 'done' });
    expect(consolidateOps.listOps(db, opened.data.id).every((op) => op.state === 'done')).toBe(
      true,
    );
  });
});

it('同批勾選改型別與抽取：共用 worker 完成兩種操作，舊型別回應不建立重複實體', async () => {
  await inDb((db) =>
    entities.insertEntity(db, { id: 'manual-retype', name: '抽進圖甲', type: 'concept', now: 1 }),
  );
  const shell = await startConsolidateShell(root, slug);
  if (!shell.ok) throw new Error(shell.code);
  const planned = await planConsolidateShell(root, slug, shell.data.id);
  if (!planned.ok) throw new Error(planned.code);
  const extract = planned.data.operations.find((op) => op.kind === 'extract');
  if (extract === undefined) throw new Error('missing extract proposal');
  await inDb((db) =>
    consolidateOps.insertOp(db, {
      id: 'mixed-retype',
      researchId: shell.data.id,
      ord: 99,
      kind: 'retype',
      payloadJson: JSON.stringify({ entityId: 'manual-retype', to: 'org' }),
      why: '合成混合操作',
    }),
  );
  expect((await setConsolidateOpChecked(root, slug, shell.data.id, extract.id, true)).ok).toBe(
    true,
  );
  expect((await setConsolidateOpChecked(root, slug, shell.data.id, 'mixed-retype', true)).ok).toBe(
    true,
  );
  const before = calls;
  expect((await executeConsolidateShell(root, slug, shell.data.id)).ok).toBe(true);
  await idle();
  expect(calls - before).toBe(1);
  await inDb((db) => {
    expect(consolidateOps.getOp(db, 'mixed-retype')?.state).toBe('done');
    expect(consolidateOps.getOp(db, extract.id)?.state).toBe('done');
    expect(entities.getEntity(db, 'manual-retype')).toMatchObject({
      type: 'org',
      typeManual: true,
    });
    expect(entities.listEntities(db).filter((e) => e.name === '抽進圖甲')).toHaveLength(1);
    const run = consolidateOps.getOp(db, extract.id)?.runId;
    expect(db.prepare('SELECT succeeded, failed FROM run WHERE id=?').get(run ?? '')).toMatchObject(
      { succeeded: 2, failed: 0 },
    );
  });
});

async function edgeDraft(): Promise<Extract<ConsolidateOpDraft, { kind: 'add-edge' }>> {
  const itemId = (await listed())[0];
  if (itemId === undefined) throw new Error('missing fixture source');
  const derived = await readDerived(join(root, 'cases', slug), itemId);
  if (derived === null) throw new Error('missing fixture body');
  await inDb((db) => {
    insertEntity(db, { id: 'issue7-a', name: '虛構補關聯甲', type: 'concept', now: 1 });
    insertEntity(db, { id: 'issue7-b', name: '虛構補關聯乙', type: 'concept', now: 1 });
  });
  return {
    kind: 'add-edge',
    payload: {
      source: 'issue7-a',
      target: 'issue7-b',
      rel: '虛構測試關係',
      itemId,
      quote: derived.text.slice(0, 40),
    },
    why: '虛構補關聯驗收',
  };
}

async function edgeShell(drafts: readonly ConsolidateOpDraft[]): Promise<string> {
  const opened = await startConsolidateShell(root, slug);
  if (!opened.ok) throw new Error(opened.code);
  const prefix = await inDb((db) =>
    consolidateOps.getOp(db, 'issue7-op-0') === null ? 'issue7-' : opened.data.id + '-',
  );
  await inDb((db) => {
    drafts.forEach((draft, ord) =>
      consolidateOps.insertOp(db, {
        id: prefix + 'op-' + String(ord),
        researchId: opened.data.id,
        ord,
        kind: draft.kind,
        payloadJson: JSON.stringify(draft.payload),
        why: draft.why,
      }),
    );
    researchRows.updateResearchStatus(db, opened.data.id, 'reviewing', Date.now());
  });
  for (let ord = 0; ord < drafts.length; ord += 1) {
    const checked = await setConsolidateOpChecked(
      root,
      slug,
      opened.data.id,
      prefix + 'op-' + String(ord),
      true,
    );
    if (!checked.ok) throw new Error(checked.code);
  }
  return opened.data.id;
}

it('補關聯完整流程：不呼叫抽取模型，寫入待查證後能復原且原端點保留', async () => {
  const draft = await edgeDraft();
  const shell = await edgeShell([draft]);
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await idle();
  expect(calls).toBe(0);
  await inDb((db) => {
    expect(findByTriple(db, draft.payload)).toMatchObject({ status: 'pending', origin: 'machine' });
    expect(consolidateOps.getOp(db, 'issue7-op-0')?.state).toBe('done');
    expect(runs.getRun(db, started.data.runId)).toMatchObject({ status: 'done', total: 1 });
  });
  const undone = await undoRun(root, slug, started.data.runId);
  expect(undone.ok, JSON.stringify(undone)).toBe(true);
  await inDb((db) => {
    expect(findByTriple(db, draft.payload)).toBeNull();
    expect(getEntity(db, 'issue7-a')).not.toBeNull();
    expect(getEntity(db, 'issue7-b')).not.toBeNull();
    expect(items.getItem(db, draft.payload.itemId)).not.toBeNull();
  });
});

it('補關聯的失效引文不寫入，其他提案仍完成並顯示原因', async () => {
  const draft = await edgeDraft();
  const invalid: ConsolidateOpDraft = {
    ...draft,
    payload: { ...draft.payload, rel: '不存在的引文', quote: '這段虛構引文不會出現在範例正文裡。' },
  };
  const shell = await edgeShell([invalid, draft]);
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await idle();
  await inDb((db) => {
    expect(findByTriple(db, invalid.payload)).toBeNull();
    expect(findByTriple(db, draft.payload)).not.toBeNull();
    expect(consolidateOps.getOp(db, 'issue7-op-0')).toMatchObject({
      state: 'stale',
      code: 'PROVIDER_QUOTE_NOT_FOUND',
    });
    expect(runs.getRun(db, started.data.runId)).toMatchObject({
      status: 'partial',
      succeeded: 1,
      failed: 1,
    });
  });
});

it('規劃定位新引文，不限定原上下文的既有出處；無法定位的提案丟棄', async () => {
  const draft = await edgeDraft();
  proposedOperations = [
    draft,
    { ...draft, payload: { ...draft.payload, quote: '完全不存在的虛構引文，不能加入清單。' } },
  ];
  const opened = await startConsolidateShell(root, slug);
  if (!opened.ok) throw new Error(opened.code);
  const planned = await planConsolidateShell(root, slug, opened.data.id);
  if (!planned.ok) throw new Error(planned.code);
  expect(planned.data.operations).toHaveLength(1);
  expect(planned.data.operations[0]).toMatchObject({
    kind: 'add-edge',
    executable: true,
    checked: false,
  });
  expect(planned.data.dropped.reasons['edge-quote-not-found']).toBe(1);
});

it('來源在確認後刪除，操作記 stale 而非整筆作業意外中止', async () => {
  const draft = await edgeDraft();
  const shell = await edgeShell([draft]);
  await inDb((db) => db.prepare('DELETE FROM item WHERE id=?').run(draft.payload.itemId));
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await idle();
  await inDb((db) => {
    expect(consolidateOps.getOp(db, 'issue7-op-0')).toMatchObject({
      state: 'stale',
      code: 'CONSOLIDATE_OP_STALE',
    });
    expect(findByTriple(db, draft.payload)).toBeNull();
    expect(runs.getRun(db, started.data.runId)?.errorCode).not.toBe('CONSOLIDATE_UNEXPECTED');
  });
});

it('補關聯後人工確認，復原保留人工判斷', async () => {
  const draft = await edgeDraft();
  const shell = await edgeShell([draft]);
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await idle();
  await inDb((db) => {
    const edge = findByTriple(db, draft.payload)!;
    setStatus(db, edge.id, 'confirmed', Date.now());
    appendAudit(db, {
      edgeId: edge.id,
      from: 'pending',
      to: 'confirmed',
      action: 'confirm',
      actor: 'human',
      runId: null,
      at: Date.now(),
    });
  });
  const undone = await undoRun(root, slug, started.data.runId);
  expect(undone).toMatchObject({ ok: true, data: { partial: true, keptEdges: 1 } });
  await inDb((db) => {
    const edge = findByTriple(db, draft.payload)!;
    expect(edge.status).toBe('confirmed');
    expect(evidenceRows(db, edge.id)).toHaveLength(1);
  });
});

it('新建關聯後另一筆作業補出處，先復原前筆不刪掉後筆內容', async () => {
  const draft = await edgeDraft();
  const firstShell = await edgeShell([draft]);
  const first = await executeConsolidateShell(root, slug, firstShell);
  if (!first.ok) throw new Error(first.code);
  await idle();
  const otherId = (await listed())[0];
  if (otherId === undefined) throw new Error('missing second source');
  const derived = await readDerived(join(root, 'cases', slug), otherId);
  if (derived === null) throw new Error('missing second body');
  const secondDraft: ConsolidateOpDraft = {
    ...draft,
    payload: {
      ...draft.payload,
      itemId: otherId,
      quote: derived.text.slice(0, 40),
    },
  };
  const secondShell = await edgeShell([secondDraft]);
  const second = await executeConsolidateShell(root, slug, secondShell);
  if (!second.ok) throw new Error(second.code);
  await idle();
  const protectedUndo = await undoRun(root, slug, first.data.runId);
  expect(protectedUndo).toMatchObject({ ok: true, data: { partial: true, keptEdges: 1 } });
  await inDb((db) => expect(evidenceRows(db, findByTriple(db, draft.payload)!.id)).toHaveLength(2));
  expect((await undoRun(root, slug, second.data.runId)).ok).toBe(true);
  await inDb((db) => expect(evidenceRows(db, findByTriple(db, draft.payload)!.id)).toHaveLength(1));
  expect((await undoRun(root, slug, first.data.runId)).ok).toBe(true);
  await inDb((db) => expect(findByTriple(db, draft.payload)).toBeNull());
});
