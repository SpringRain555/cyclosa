/**
 * 抽進圖（整理的第一片，ADR-0033 S24）：從列清單、勾、抽、到復原，走真的服務與一個假的 Ollama。
 *
 * 假模型回的引文取自**這一次送來的正文開頭** —— 抽好幾份的時候每一份都要對得回自己的原文，
 * 不然 `locateQuote` 找不到、那一條不會寫進去，測試就量不到「真的抽進圖了」。
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
import {
  activeCount,
  cancel,
  cancelAll,
  pause,
  resume,
} from '../../src/application/run-registry.js';
import { createSampleCase } from '../../src/application/sample-service.js';
import { undoRun } from '../../src/application/undo-service.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import {
  removeDerived,
  readDerived,
  writeDerived,
} from '../../src/infrastructure/fs/case-files.js';
import { listUndigestedItems } from '../../src/application/consolidate-digest.js';
import { updateCaseStatus } from '../../src/infrastructure/db/repositories/case-repo.js';
import * as items from '../../src/infrastructure/db/repositories/item-repo.js';
import * as runs from '../../src/infrastructure/db/repositories/run-repo.js';
import * as consolidateOps from '../../src/infrastructure/db/repositories/consolidate-op-repo.js';
import * as researchRows from '../../src/infrastructure/db/repositories/research-repo.js';

let server: Server;
let baseUrl = '';
let sandbox = '';
let root = '';
let slug = '';
let saved: string | undefined;
let calls = 0;
let holdAt = 0;
let held: ServerResponse | null = null;
let digestCalls = 0;
let digestFailsAt = 0;
let plannerKind: 'extract' | 'digest' = 'extract';
let contextTokens = 128_000;
const digestReply = {
  relevance: 'unsure',
  why: '虛構測試',
  title_zh: '虛構繁中標題',
  summary_zh: '這是虛構資料的繁中摘要。',
};

async function inDb<T>(body: (db: DatabaseSync) => T): Promise<T> {
  const opened = await openCaseDatabase(join(root, 'cases', slug, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(opened.kind);
  try {
    return await body(opened.db);
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
              details: { context_length: contextTokens },
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
      const system = parsed.messages.find((m) => m.role === 'system')?.content ?? '';
      if (system.includes('專題資料整理的規劃助手')) {
        const context = JSON.parse(user) as {
          unextracted: { id: string }[];
          undigested: { id: string }[];
        };
        const itemIds = (plannerKind === 'digest' ? context.undigested : context.unextracted)
          .slice(0, 2)
          .map((entry) => entry.id);
        res.end(
          JSON.stringify({
            message: {
              content: JSON.stringify({
                operations: itemIds.map((itemId) => ({
                  kind: plannerKind,
                  payload: { itemIds: [itemId] },
                  why: '合成規劃建議抽取這份未整理資料',
                })),
              }),
            },
          }),
        );
        return;
      }
      if (system.includes('「初讀」')) {
        digestCalls += 1;
        res.end(
          JSON.stringify({
            message: {
              content: JSON.stringify(
                digestCalls === digestFailsAt
                  ? { relevance: 'invalid', title_zh: '', summary_zh: '' }
                  : digestReply,
              ),
            },
          }),
        );
        return;
      }
      const separator = String.fromCharCode(10);
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
  digestCalls = 0;
  digestFailsAt = 0;
  plannerKind = 'extract';
  contextTokens = 128_000;
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

async function digestItems(): Promise<string[]> {
  return inDb(async (db) =>
    (await listUndigestedItems(db, join(root, 'cases', slug))).map((entry) => entry.id),
  );
}

async function digestShell(ids: readonly string[]): Promise<string> {
  const opened = await startConsolidateShell(root, slug);
  if (!opened.ok) throw new Error(opened.code);
  await inDb((db) => {
    consolidateOps.insertOp(db, {
      id: 'digest-op',
      researchId: opened.data.id,
      ord: 0,
      kind: 'digest',
      payloadJson: JSON.stringify({ itemIds: ids }),
      why: '虛構初讀測試',
    });
    researchRows.updateResearchStatus(db, opened.data.id, 'reviewing', Date.now());
  });
  const checked = await setConsolidateOpChecked(root, slug, opened.data.id, 'digest-op', true);
  if (!checked.ok) throw new Error(checked.code);
  return opened.data.id;
}

async function changeTask(task: string, model: string): Promise<void> {
  const path = join(sandbox, 'local', 'Cyclosa', 'providers.json');
  const config = JSON.parse(await readFile(path, 'utf8')) as { tasks: Record<string, unknown> };
  config.tasks[task] = { via: 'ollama', model };
  await writeFile(path, JSON.stringify(config), 'utf8');
}

it('純補繁中只要求 digest，不改原文、正文與圖，逐份留下成本紀錄', async () => {
  const ids = (await digestItems()).slice(0, 2);
  expect(ids).toHaveLength(2);
  const before = await inDb((db) => ids.map((id) => items.getItem(db, id)));
  const bodies = await Promise.all(ids.map((id) => readDerived(join(root, 'cases', slug), id)));
  const edges = await inDb((db) => db.prepare('SELECT * FROM edge ORDER BY id').all());
  const shell = await digestShell(ids);
  await changeTask('extract', '');
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(JSON.stringify(started));
  await idle();
  expect(digestCalls).toBe(2);
  expect(calls).toBe(2);
  await inDb((db) => {
    ids.forEach((id, index) => {
      const after = items.getItem(db, id)!;
      expect(after).toMatchObject({
        titleZh: digestReply.title_zh,
        summaryZh: digestReply.summary_zh,
        digestedBy: 'ollama:fake-extract',
      });
      expect(after.digestedAt).not.toBeNull();
      expect({
        ...after,
        titleZh: null,
        summaryZh: null,
        digestedBy: null,
        digestedAt: null,
      }).toEqual(before[index]);
    });
    expect(db.prepare('SELECT * FROM edge ORDER BY id').all()).toEqual(edges);
    expect(runs.getRun(db, started.data.runId)).toMatchObject({
      status: 'done',
      total: 2,
      requests: 2,
      costUsd: 0,
      unpriced: 0,
    });
    const raw = db
      .prepare('SELECT task_costs_json FROM run WHERE id=?')
      .get(started.data.runId) as { task_costs_json: string };
    expect(JSON.parse(raw.task_costs_json)).toMatchObject({ digest: { requests: 2, costUsd: 0 } });
  });
  expect(await Promise.all(ids.map((id) => readDerived(join(root, 'cases', slug), id)))).toEqual(
    bodies,
  );
});

it('同一操作多份資料，第一份失敗不影響第二份且整筆 partial', async () => {
  const ids = (await digestItems()).slice(0, 2);
  const shell = await digestShell(ids);
  digestFailsAt = 1;
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await idle();
  expect(digestCalls).toBe(2);
  await inDb((db) => {
    expect(items.getItem(db, ids[0]!)?.digestedAt).toBeNull();
    expect(items.getItem(db, ids[1]!)?.digestedAt).not.toBeNull();
    expect(runs.getRun(db, started.data.runId)).toMatchObject({
      status: 'partial',
      succeeded: 1,
      failed: 1,
    });
    expect(consolidateOps.getOp(db, 'digest-op')).toMatchObject({
      state: 'failed',
      code: 'PROVIDER_OUTPUT_SCHEMA_MISMATCH',
    });
  });
});

it('規劃只給尚未初讀的資料，digest 可執行且預設不勾', async () => {
  const ids = await digestItems();
  await inDb((db) =>
    items.setItemDigest(db, {
      id: ids[0]!,
      titleZh: '保留的舊標題',
      summaryZh: '',
      digestedBy: 'old',
      now: 1,
    }),
  );
  plannerKind = 'digest';
  const opened = await startConsolidateShell(root, slug);
  if (!opened.ok) throw new Error(opened.code);
  const planned = await planConsolidateShell(root, slug, opened.data.id);
  if (!planned.ok) throw new Error(planned.code);
  expect(planned.data.operations.length).toBeGreaterThan(0);
  for (const operation of planned.data.operations) {
    expect(operation).toMatchObject({ kind: 'digest', executable: true, checked: false });
    expect((operation.payload as { itemIds: string[] }).itemIds).not.toContain(ids[0]);
  }
  expect(planned.data.coverage?.undigestedAvailable).toBe(ids.length - 1);
});

it.each(['', 'missing-model'])(
  '初讀任務配不上（%s）時先停，不開作業並指出 digest',
  async (model) => {
    const shell = await digestShell((await digestItems()).slice(0, 1));
    await changeTask('digest', model);
    const before = await inDb((db) => runs.listRuns(db, 100).length);
    const result = await executeConsolidateShell(root, slug, shell);
    expect(result).toMatchObject({ ok: false, detail: { task: 'digest' } });
    expect(await inDb((db) => runs.listRuns(db, 100).length)).toBe(before);
    expect(calls).toBe(0);
  },
);

it('初讀 context 不足時指出 digest 任務與能力缺口', async () => {
  const shell = await digestShell((await digestItems()).slice(0, 1));
  contextTokens = 512;
  const result = await executeConsolidateShell(root, slug, shell);
  expect(result).toMatchObject({
    ok: false,
    code: 'PROVIDER_CAPABILITY_MISSING',
    detail: { task: 'digest', haveContextTokens: 512 },
  });
  expect(calls).toBe(0);
});

it('模型等待期間另一作業寫入初讀，晚到結果不覆寫', async () => {
  const id = (await digestItems())[0]!;
  const shell = await digestShell([id]);
  holdAt = 1;
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await expect.poll(() => held !== null).toBe(true);
  await inDb((db) =>
    items.setItemDigest(db, {
      id,
      titleZh: '另一作業先完成',
      summaryZh: '保留內容',
      digestedBy: 'other',
      now: Date.now(),
    }),
  );
  held!.end(JSON.stringify({ message: { content: JSON.stringify(digestReply) } }));
  await idle();
  await inDb((db) => {
    expect(items.getItem(db, id)).toMatchObject({ titleZh: '另一作業先完成', digestedBy: 'other' });
    expect(consolidateOps.getOp(db, 'digest-op')).toMatchObject({
      state: 'stale',
      code: 'CONSOLIDATE_OP_STALE',
    });
  });
});

it('模型等待期間取消，不寫回晚到初讀', async () => {
  const id = (await digestItems())[0]!;
  const shell = await digestShell([id]);
  holdAt = 1;
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await expect.poll(() => held !== null).toBe(true);
  cancel(started.data.runId);
  held!.end(JSON.stringify({ message: { content: JSON.stringify(digestReply) } }));
  await idle();
  await inDb((db) => {
    expect(items.getItem(db, id)?.digestedAt).toBeNull();
    expect(runs.getRun(db, started.data.runId)?.status).toBe('cancelled');
  });
});

it('模型等待期間封存，不寫入也不再呼叫剩餘資料', async () => {
  const ids = (await digestItems()).slice(0, 2);
  const shell = await digestShell(ids);
  holdAt = 1;
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await expect.poll(() => held !== null).toBe(true);
  await inDb((db) => updateCaseStatus(db, 'archived', Date.now()));
  held!.end(JSON.stringify({ message: { content: JSON.stringify(digestReply) } }));
  await idle();
  expect(calls).toBe(1);
  await inDb((db) => {
    for (const id of ids) expect(items.getItem(db, id)?.digestedAt).toBeNull();
  });
});

it('選取後正文消失時標 stale，不呼叫模型', async () => {
  const id = (await digestItems())[0]!;
  const shell = await digestShell([id]);
  await removeDerived(join(root, 'cases', slug), id);
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await idle();
  expect(calls).toBe(0);
  await inDb((db) =>
    expect(consolidateOps.getOp(db, 'digest-op')).toMatchObject({ state: 'stale' }),
  );
});

it('並行送出只有一筆補繁中作業', async () => {
  const shell = await digestShell((await digestItems()).slice(0, 1));
  const results = await Promise.all([
    executeConsolidateShell(root, slug, shell),
    executeConsolidateShell(root, slug, shell),
  ]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  await idle();
  expect(calls).toBe(1);
});

it('純補繁中作業復原不清理圖、原實體或已產生的衍生內容', async () => {
  const id = (await digestItems())[0]!;
  const shell = await digestShell([id]);
  await inDb((db) =>
    db
      .prepare(
        "INSERT INTO entity (id,type,name_zh,created_at,updated_at) VALUES ('digest-orphan','concept','虛構保留實體',1,1)",
      )
      .run(),
  );
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await idle();
  expect(await undoRun(root, slug, started.data.runId)).toMatchObject({
    ok: true,
    data: { deletedItems: 0, deletedEdges: 0, deletedEntities: 0 },
  });
  await inDb((db) => {
    expect(db.prepare("SELECT id FROM entity WHERE id='digest-orphan'").get()).toBeDefined();
    expect(items.getItem(db, id)?.titleZh).toBe(digestReply.title_zh);
    expect(runs.isDigestOnlyRun(runs.getRun(db, started.data.runId)!)).toBe(true);
  });
});

it('已規劃的資料在執行前有舊繁中內容時不重讀、不覆寫', async () => {
  const id = (await digestItems())[0]!;
  const shell = await digestShell([id]);
  await inDb((db) => db.prepare('UPDATE item SET title_zh=? WHERE id=?').run('歷史繁中標題', id));
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await idle();
  expect(calls).toBe(0);
  await inDb((db) => expect(items.getItem(db, id)?.titleZh).toBe('歷史繁中標題'));
});

it('混合抽取與初讀按固定順序完成，兩個任務的呼叫成本均保留', async () => {
  const extractable = new Set(await listed());
  const id = (await digestItems()).find((candidate) => extractable.has(candidate))!;
  expect(await listed()).toContain(id);
  const shell = await digestShell([id]);
  await inDb((db) => {
    // 刻意把抽取放在較後的序號，執行仍必須先抽取再補繁中。
    consolidateOps.insertOp(db, {
      id: 'extract-mixed',
      researchId: shell,
      ord: 1,
      kind: 'extract',
      payloadJson: JSON.stringify({ itemIds: [id] }),
      why: '虛構混合操作',
    });
  });
  expect((await setConsolidateOpChecked(root, slug, shell, 'extract-mixed', true)).ok).toBe(true);
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await idle();
  expect(calls).toBe(2);
  expect(digestCalls).toBe(1);
  await inDb((db) => {
    expect(items.getItem(db, id)).toMatchObject({ titleZh: digestReply.title_zh });
    expect(items.getItem(db, id)?.extractedAt).not.toBeNull();
    const raw = db
      .prepare('SELECT task_costs_json,requests FROM run WHERE id=?')
      .get(started.data.runId) as { task_costs_json: string; requests: number };
    expect(raw.requests).toBe(2);
    expect(JSON.parse(raw.task_costs_json)).toMatchObject({
      digest: { requests: 1 },
      extract: { requests: 1 },
    });
    expect(runs.isDigestOnlyRun(runs.getRun(db, started.data.runId)!)).toBe(false);
  });
});

it('初讀等待時正文被重算，不把舊正文的摘要寫進新正文', async () => {
  const id = (await digestItems())[0]!;
  const shell = await digestShell([id]);
  const folder = join(root, 'cases', slug);
  const original = (await readDerived(folder, id))!;
  holdAt = 1;
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await expect.poll(() => held !== null).toBe(true);
  await writeDerived(folder, id, { ...original, text: original.text + '\n虛構的新正文。' });
  held!.end(JSON.stringify({ message: { content: JSON.stringify(digestReply) } }));
  await idle();
  await inDb((db) => {
    expect(items.getItem(db, id)?.digestedAt).toBeNull();
    expect(consolidateOps.getOp(db, 'digest-op')?.state).toBe('stale');
    expect(runs.getRun(db, started.data.runId)?.requests).toBe(1);
  });
});

it('初讀等待時資料被排除，晚到結果不寫入', async () => {
  const id = (await digestItems())[0]!;
  const shell = await digestShell([id]);
  holdAt = 1;
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await expect.poll(() => held !== null).toBe(true);
  await inDb((db) => db.prepare("UPDATE item SET status='excluded' WHERE id=?").run(id));
  held!.end(JSON.stringify({ message: { content: JSON.stringify(digestReply) } }));
  await idle();
  await inDb((db) => {
    expect(items.getItem(db, id)?.digestedAt).toBeNull();
    expect(consolidateOps.getOp(db, 'digest-op')?.state).toBe('stale');
  });
});

it('初讀等待時資料被刪除，不因來源外鍵中止後續資料', async () => {
  const ids = (await digestItems()).slice(0, 2);
  const shell = await digestShell(ids);
  holdAt = 1;
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await expect.poll(() => held !== null).toBe(true);
  await inDb((db) => db.prepare('DELETE FROM item WHERE id=?').run(ids[0]!));
  held!.end(JSON.stringify({ message: { content: JSON.stringify(digestReply) } }));
  await idle();
  expect(calls).toBe(2);
  await inDb((db) => {
    expect(items.getItem(db, ids[0]!)).toBeNull();
    expect(items.getItem(db, ids[1]!)?.digestedAt).not.toBeNull();
    expect(runs.getRun(db, started.data.runId)).toMatchObject({ status: 'partial', requests: 2 });
  });
});

it('初讀暫停會完成當前一份，續跑才處理下一份', async () => {
  const ids = (await digestItems()).slice(0, 2);
  const shell = await digestShell(ids);
  holdAt = 1;
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await expect.poll(() => held !== null).toBe(true);
  expect(pause(started.data.runId)).toBe(true);
  held!.end(JSON.stringify({ message: { content: JSON.stringify(digestReply) } }));
  await expect
    .poll(async () => inDb((db) => items.getItem(db, ids[0]!)?.digestedAt !== null))
    .toBe(true);
  expect(activeCount()).toBe(1);
  expect(calls).toBe(1);
  await inDb((db) => expect(items.getItem(db, ids[1]!)?.digestedAt).toBeNull());
  expect(resume(started.data.runId)).toBe(true);
  await idle();
  expect(calls).toBe(2);
  await inDb((db) => expect(runs.getRun(db, started.data.runId)?.status).toBe('done'));
});

it('部分初讀後取消保留已寫入，重試不重讀第一份', async () => {
  const ids = (await digestItems()).slice(0, 2);
  const shell = await digestShell(ids);
  holdAt = 2;
  const started = await executeConsolidateShell(root, slug, shell);
  if (!started.ok) throw new Error(started.code);
  await expect.poll(() => held !== null).toBe(true);
  const before = await inDb((db) => items.getItem(db, ids[0]!));
  expect(before?.digestedAt).not.toBeNull();
  cancel(started.data.runId);
  held!.end(JSON.stringify({ message: { content: JSON.stringify(digestReply) } }));
  await idle();
  await inDb((db) => {
    expect(items.getItem(db, ids[1]!)?.digestedAt).toBeNull();
    expect(researchRows.getResearch(db, shell)?.status).toBe('reviewing');
  });
  const retried = await executeConsolidateShell(root, slug, shell);
  if (!retried.ok) throw new Error(retried.code);
  await idle();
  expect(calls).toBe(3);
  await inDb((db) => {
    expect(items.getItem(db, ids[0]!)).toEqual(before);
    expect(items.getItem(db, ids[1]!)?.digestedAt).not.toBeNull();
  });
});
