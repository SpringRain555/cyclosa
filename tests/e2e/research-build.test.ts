import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { initDataRoot } from '../../src/application/bootstrap-service.js';
import { createSampleCase } from '../../src/application/sample-service.js';
import { startResearch, getResearchView } from '../../src/application/research-service.js';
import {
  editCandidateDecision,
  startBuilding,
  finishBuilding,
} from '../../src/application/research-build.js';
import { activeCount, cancel, cancelAll } from '../../src/application/run-registry.js';
import { forgetSwept } from '../../src/application/run-sweep.js';
import { loadProviders } from '../../src/infrastructure/providers/registry.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import * as research from '../../src/infrastructure/db/repositories/research-repo.js';
import * as items from '../../src/infrastructure/db/repositories/item-repo.js';
import * as runs from '../../src/infrastructure/db/repositories/run-repo.js';
import { readDerived, writeDerived } from '../../src/infrastructure/fs/case-files.js';
import { searchCase } from '../../src/application/search-service.js';
import { newId } from '../../src/shared/id.js';
import { createEdge, transitionEdge } from '../../src/application/edge-service.js';
import { insertEntity, addAlias } from '../../src/infrastructure/db/repositories/entity-repo.js';

let server: Server;
let baseUrl = '';
let sandbox = '';
let root = '';
let slug = '';
let researchId = '';
let saved: string | undefined;
let contextTokens = 128_000;
let calls = 0;
let holdAt = 0;
let held: ServerResponse | null = null;
let quote = '';
let replyInvalid = false;
let candidateIds: string[] = [];
let itemIds: string[] = [];
const calledModels: string[] = [];

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

async function view() {
  const result = await getResearchView(root, slug, researchId);
  if (!result.ok) throw new Error(result.code);
  return result.data;
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
    } else if (req.url === '/api/chat') {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => {
        calledModels.push((JSON.parse(body) as { model: string }).model);
        calls += 1;
        if (calls === holdAt) {
          held = res;
          return;
        }
        const extraction = replyInvalid
          ? { invalid: true }
          : {
              entities: [
                { name: '測試甲', type: 'concept' },
                { name: '測試乙', type: 'concept' },
              ],
              relations: [{ subject: '測試甲', object: '測試乙', rel: '測試關係', quote }],
            };
        res.end(
          JSON.stringify({
            message: { content: replyInvalid ? 'not JSON' : JSON.stringify(extraction) },
          }),
        );
      });
    } else {
      res.statusCode = 404;
      res.end();
    }
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
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-build-'));
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
        ['plan', 'find-sources', 'digest', 'angles', 'extract', 'embed'].map((task) => [
          task,
          { via: 'ollama', model: 'fake-extract' },
        ]),
      ),
      diagnostics: { logModelCalls: false },
    }),
    'utf8',
  );
  contextTokens = 128_000;
  calls = 0;
  calledModels.length = 0;
  holdAt = 0;
  held = null;
  replyInvalid = false;
  expect((await initDataRoot(root)).ok).toBe(true);
  const sample = await createSampleCase(root);
  if (!sample.ok) throw new Error(JSON.stringify(sample));
  slug = sample.data.slug;
  const started = await startResearch(root, slug, { topic: '合成研究' });
  if (!started.ok) throw new Error(started.code);
  researchId = started.data.id;
  const sourceItems = await inDb(
    (db) =>
      db.prepare("SELECT id FROM item WHERE status = 'included' ORDER BY id LIMIT 3").all() as {
        id: string;
      }[],
  );
  itemIds = sourceItems.map((entry) => entry.id);
  const derived = await readDerived(join(root, 'cases', slug), itemIds[0]!);
  quote = derived!.text.slice(0, 40);
  candidateIds = Array.from({ length: 4 }, () => newId());
  await inDb((db) => {
    const directionId = newId();
    research.insertDirection(db, {
      id: directionId,
      researchId,
      ord: 0,
      title: '測試方向',
      what: '',
      expect: '',
      keywords: [],
      origin: 'human',
      adopted: true,
      now: Date.now(),
    });
    for (const [index, id] of candidateIds.entries()) {
      research.addCandidate(db, {
        id,
        researchId,
        directionId,
        url: `https://example.test/${index}`,
        title: `合成候選 ${index}`,
        why: '測試理由',
        bib: { authors: '測試作者', year: '2026', venue: '測試期刊' },
        expectedAccess: 'unknown',
        acquisition: index < 3 ? 'uploaded' : 'needs-user',
        now: Date.now(),
      });
      if (index < 3) research.setCandidateItem(db, id, itemIds[index]!, Date.now());
      research.setCandidateDecision(
        db,
        id,
        index === 0 ? 'include' : index === 2 ? 'discard' : 'reference',
        Date.now(),
      );
    }
    research.setCandidateCitedBy(db, candidateIds[3]!, [candidateIds[0]!], Date.now());
    research.updateResearchStatus(db, researchId, 'reviewing', Date.now());
  });
});

afterEach(async () => {
  cancelAll();
  held?.destroy();
  await idle();
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

it('進圖走真抽取；書目、人建引用、排除、留著不抽與花費都有紀錄', async () => {
  const started = await startBuilding(root, slug, researchId);
  expect(started.ok, JSON.stringify(started)).toBe(true);
  await idle();
  const end = await view();
  expect(end.status).toBe('done');
  expect(end.build.done).toBe(4);
  expect(calls).toBe(1);
  expect(end.costByTask['extract']?.requests).toBe(1);
  await inDb((db) => {
    const run = runs.getRun(db, end.build.runId!)!;
    expect(run).toMatchObject({ kind: 'research', label: '建圖' });
    const runItems = runs.listRunItems(db, run.id);
    expect(runItems).toHaveLength(4);
    expect(runItems.reduce((total, entry) => total + entry.newEdges, 0)).toBeGreaterThan(1);
    expect(items.getItem(db, itemIds[0]!)?.extractedBy).toBe('ollama:fake-extract');
    expect(items.getItem(db, itemIds[1]!)?.extractedAt).toBeNull();
    expect(items.getItem(db, itemIds[2]!)?.status).toBe('excluded');
    const referenceId = research.getCandidate(db, candidateIds[3]!)!.itemId!;
    const reference = items.getItem(db, referenceId)!;
    expect(reference).toMatchObject({
      kind: 'reference',
      sha256: null,
      sourceUrl: 'https://example.test/3',
    });
    expect(JSON.parse(reference.bibJson!)).toMatchObject({ why: '測試理由', authors: '測試作者' });
    expect(
      db
        .prepare('SELECT origin, status, source_id, target_id FROM edge WHERE target_id = ?')
        .get(referenceId),
    ).toMatchObject({
      origin: 'human',
      status: 'confirmed',
      source_id: itemIds[0],
      target_id: referenceId,
    });
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS total FROM edge WHERE run_id = ? AND origin = 'machine' AND layer = 'named'",
        )
        .get(run.id),
    ).toMatchObject({ total: 1 });
  });
});

it('確認可改與恢復預設，沒正文不能進圖；引用來源必須存在', async () => {
  const edited = await editCandidateDecision(root, slug, researchId, candidateIds[0]!, {
    decision: 'reference',
  });
  expect(edited.ok && edited.data.candidates[0]?.decision).toBe('reference');
  const reset = await editCandidateDecision(root, slug, researchId, candidateIds[0]!, {
    decision: null,
  });
  expect(reset.ok && reset.data.candidates[0]?.decision).toBeNull();
  expect(
    (await editCandidateDecision(root, slug, researchId, candidateIds[3]!, { decision: 'include' }))
      .ok,
  ).toBe(false);
  expect(
    (
      await editCandidateDecision(root, slug, researchId, candidateIds[3]!, {
        citedBy: ['missing'],
      })
    ).ok,
  ).toBe(false);
});

it('取消後繼續只做沒 done 的候選', async () => {
  await inDb((db) => research.setCandidateDecision(db, candidateIds[1]!, 'include', Date.now()));
  holdAt = 2;
  const started = await startBuilding(root, slug, researchId);
  expect(started.ok).toBe(true);
  await expect.poll(() => calls).toBe(2);
  const runId = (await view()).build.runId!;
  cancel(runId);
  held?.destroy();
  await idle();
  expect(await view()).toMatchObject({
    status: 'building',
    build: { done: 1, mayResume: true, mayFinish: true },
  });
  holdAt = 0;
  expect((await startBuilding(root, slug, researchId)).ok).toBe(true);
  await idle();
  expect((await view()).status).toBe('done');
  expect(calls).toBe(3);
  const second = (await view()).build.runId!;
  expect(await inDb((db) => runs.listRunItems(db, second).length)).toBe(3);
});

it('取消後到此為止會收尾，不再抽取', async () => {
  holdAt = 1;
  expect((await startBuilding(root, slug, researchId)).ok).toBe(true);
  await expect.poll(() => calls).toBe(1);
  cancel((await view()).build.runId!);
  held?.destroy();
  await idle();
  const finished = await finishBuilding(root, slug, researchId);
  expect(finished.ok && finished.data.status).toBe('done');
  expect(calls).toBe(1);
});

it('程式關掉的中斷只能繼續，不能到此為止', async () => {
  holdAt = 1;
  expect((await startBuilding(root, slug, researchId)).ok).toBe(true);
  await expect.poll(() => calls).toBe(1);
  cancel((await view()).build.runId!, 'shutdown');
  held?.destroy();
  await idle();
  expect((await view()).build).toMatchObject({ mayResume: true, mayFinish: false });
  expect((await finishBuilding(root, slug, researchId)).ok).toBe(false);
});

it('閘門三能力不足帶 extract 任務，不建立作業、不換狀態', async () => {
  contextTokens = 100;
  const result = await startBuilding(root, slug, researchId);
  expect(result).toMatchObject({
    ok: false,
    code: 'PROVIDER_CAPABILITY_MISSING',
    detail: { task: 'extract' },
  });
  expect(await view()).toMatchObject({ status: 'reviewing', build: { runId: null } });
  expect(calls).toBe(0);
});

it('抽取失敗不妨礙其餘候選，作業保留部分完成', async () => {
  replyInvalid = true;
  expect((await startBuilding(root, slug, researchId)).ok).toBe(true);
  await idle();
  const end = await view();
  expect(end.status).toBe('done');
  expect(end.candidates[0]?.buildState).toBe('failed');
  expect(await inDb((db) => runs.getRun(db, end.build.runId!)?.status)).toBe('partial');
  expect(end.build.done).toBe(3);
});

it('JSON 尚未量過會先量；量出不支援就擋在閘門三', async () => {
  const providers = await loadProviders();
  const chat = providers.chatFor('extract');
  if (chat === null) throw new Error('missing fixture provider');
  let measured = 0;
  const result = await startBuilding(root, slug, researchId, async () => ({
    ...providers,
    chatFor: () => ({
      ...chat,
      jsonMode: async () => ({ mode: 'unchecked', checkedAt: null, detail: '', protocol: null }),
      checkJson: async () => {
        measured += 1;
        return {
          kind: 'ok',
          value: { mode: 'none', checkedAt: Date.now(), detail: '', protocol: null },
          cost: { costUsd: null, elapsedMs: 1 },
        };
      },
    }),
  }));
  expect(result).toMatchObject({
    ok: false,
    code: 'PROVIDER_JSON_UNSUPPORTED',
    detail: { task: 'extract' },
  });
  expect(measured).toBe(1);
  expect((await view()).status).toBe('reviewing');
  expect(calls).toBe(0);
});

it('閘門三抽取沒設定會指出任務', async () => {
  const providers = await loadProviders();
  const result = await startBuilding(root, slug, researchId, async () => ({
    ...providers,
    chatFor: () => null,
  }));
  expect(result).toMatchObject({
    ok: false,
    code: 'PROVIDER_NOT_CONFIGURED',
    detail: { task: 'extract' },
  });
  expect((await view()).status).toBe('reviewing');
});

it('建圖還在跑時不准重開作業、改決定或到此為止', async () => {
  holdAt = 1;
  expect((await startBuilding(root, slug, researchId)).ok).toBe(true);
  await expect.poll(() => calls).toBe(1);
  expect((await startBuilding(root, slug, researchId)).ok).toBe(false);
  expect(
    (await editCandidateDecision(root, slug, researchId, candidateIds[0]!, { decision: 'discard' }))
      .ok,
  ).toBe(false);
  expect((await finishBuilding(root, slug, researchId)).ok).toBe(false);
});

it('重啟掃掉孤兒建圖作業後，保留 done 候選並可接著做', async () => {
  await inDb((db) => {
    const runId = newId();
    runs.insertRun(db, {
      id: runId,
      kind: 'research',
      label: '建圖',
      total: 4,
      correlationId: newId(),
      now: Date.now(),
      researchId,
    });
    runs.startRun(db, runId, Date.now());
    research.setBuildRun(db, researchId, runId, Date.now());
    research.updateResearchStatus(db, researchId, 'building', Date.now());
    research.setCandidateBuild(db, {
      id: candidateIds[0]!,
      state: 'done',
      code: null,
      now: Date.now(),
    });
  });
  forgetSwept();
  const before = await view();
  expect(before.build).toMatchObject({ mayResume: true, mayFinish: false, done: 1 });
  expect(await inDb((db) => runs.getRun(db, before.build.runId!)?.endedReason)).toBe('stale');
  expect((await startBuilding(root, slug, researchId)).ok).toBe(true);
  await idle();
  expect((await view()).build.done).toBe(4);
  expect(calls).toBe(0);
});

async function buildAgain(): Promise<void> {
  await inDb((db) => {
    research.updateResearchStatus(db, researchId, 'reviewing', Date.now());
    research.setCandidateBuild(db, {
      id: candidateIds[0]!,
      state: null,
      code: null,
      now: Date.now(),
    });
  });
  expect((await startBuilding(root, slug, researchId)).ok).toBe(true);
  await idle();
}

it('引用儲存同研究候選 id，拒絕資料 id、自引與其他研究候選', async () => {
  await inDb((db) => research.updateResearchStatus(db, researchId, 'done', Date.now()));
  const other = await startResearch(root, slug, { topic: '另一個合成研究' });
  if (!other.ok) throw new Error(other.code);
  await inDb((db) => {
    research.updateResearchStatus(db, other.data.id, 'done', Date.now());
    research.updateResearchStatus(db, researchId, 'reviewing', Date.now());
    research.insertDirection(db, {
      id: 'outside-direction',
      researchId: other.data.id,
      ord: 0,
      title: '另一方向',
      what: '',
      expect: '',
      keywords: [],
      origin: 'human',
      adopted: true,
      now: 1,
    });
    research.addCandidate(db, {
      id: 'outside',
      researchId: other.data.id,
      directionId: 'outside-direction',
      url: 'https://example.test/outside',
      title: '外部候選',
      why: '',
      bib: { authors: '', year: '', venue: '' },
      expectedAccess: 'unknown',
      acquisition: 'uploaded',
      now: 1,
    });
    research.setCandidateItem(db, 'outside', itemIds[0]!, 1);
  });
  for (const invalid of [itemIds[0]!, candidateIds[3]!, 'outside']) {
    expect(
      (
        await editCandidateDecision(root, slug, researchId, candidateIds[3]!, {
          citedBy: [invalid],
        })
      ).ok,
    ).toBe(false);
  }
  const edited = await editCandidateDecision(root, slug, researchId, candidateIds[3]!, {
    citedBy: [candidateIds[0]!, candidateIds[0]!],
  });
  expect(edited.ok).toBe(true);
  expect(await inDb((db) => research.getCandidate(db, candidateIds[3]!)?.citedBy)).toEqual([
    candidateIds[0],
  ]);
});

it('取得成功但正文空白時，回應與建圖都按書目處理', async () => {
  const folder = join(root, 'cases', slug);
  const derived = await readDerived(folder, itemIds[1]!);
  await writeDerived(folder, itemIds[1]!, { ...derived!, text: '   \n' });
  expect((await view()).candidates.find((entry) => entry.id === candidateIds[1])).toMatchObject({
    acquisition: 'uploaded',
    hasBody: false,
  });
  expect(
    (await editCandidateDecision(root, slug, researchId, candidateIds[1]!, { decision: 'include' }))
      .ok,
  ).toBe(false);
  expect(
    (
      await editCandidateDecision(root, slug, researchId, candidateIds[1]!, {
        citedBy: [candidateIds[0]!],
      })
    ).ok,
  ).toBe(true);
  await buildAgain();
  const reference = (await view()).candidates.find((entry) => entry.id === candidateIds[1])!;
  expect(reference.itemId).not.toBe(itemIds[1]);
  expect(await inDb((db) => items.getItem(db, reference.itemId!)?.kind)).toBe('reference');
  expect(
    await inDb((db) =>
      db.prepare('SELECT source_id FROM edge WHERE target_id = ?').all(reference.itemId),
    ),
  ).toEqual([{ source_id: itemIds[0] }]);
});

it('新建書目標題可用中英文全文搜尋', async () => {
  await inDb((db) =>
    db
      .prepare('UPDATE research_candidate SET title = ? WHERE id = ?')
      .run('獨特書目 Bibliographicfixture', candidateIds[3]!),
  );
  await buildAgain();
  const referenceId = (await view()).candidates.find(
    (entry) => entry.id === candidateIds[3],
  )!.itemId;
  for (const query of ['獨特書目', 'Bibliographicfixture']) {
    const found = await searchCase(root, slug, { q: query, mode: 'text' });
    expect(found.ok && found.data.hits.some((entry) => entry.id === referenceId)).toBe(true);
  }
});

it('實體別名對齊後不建立自連，仍完成其餘候選', async () => {
  await inDb((db) => {
    insertEntity(db, { id: 'same-entity', name: '測試甲', type: 'concept', now: 1 });
    addAlias(db, 'same-entity', '測試乙', 2);
  });
  await buildAgain();
  expect((await view()).build.done).toBe(4);
  expect(await inDb((db) => db.prepare("SELECT * FROM edge WHERE rel = '測試關係'").all())).toEqual(
    [],
  );
});

it('單份寫入違反約束時交易退回，其餘候選仍完成', async () => {
  const before = await inDb((db) => db.prepare('SELECT * FROM entity ORDER BY id').all());
  await inDb((db) =>
    db.exec(
      "CREATE TRIGGER fail_extraction BEFORE INSERT ON entity WHEN NEW.name_zh = '測試乙' BEGIN SELECT RAISE(ABORT, 'fixture extraction failure'); END",
    ),
  );
  await buildAgain();
  const result = await view();
  expect(result.candidates.find((entry) => entry.id === candidateIds[0])).toMatchObject({
    buildState: 'failed',
    buildCode: 'RESEARCH_UNEXPECTED',
  });
  expect(result.build.done).toBe(3);
  expect(await inDb((db) => runs.getRun(db, result.build.runId!)?.status)).toBe('partial');
  expect(await inDb((db) => db.prepare('SELECT * FROM entity ORDER BY id').all())).toEqual(before);
});

it('建圖重跑不改人的子集，也不覆寫人工確認', async () => {
  await buildAgain();
  const edge = await inDb(
    (db) =>
      db
        .prepare(
          "SELECT id, source_id, target_id FROM edge WHERE layer = 'named' AND origin = 'machine' AND rel = '測試關係'",
        )
        .get() as { id: string; source_id: string; target_id: string },
  );
  expect((await transitionEdge(root, slug, edge.id, 'confirm')).ok).toBe(true);
  expect(
    (
      await createEdge(root, slug, {
        source: edge.source_id,
        target: edge.target_id,
        rel: '人自己連的',
        layer: 'named',
      })
    ).ok,
  ).toBe(true);
  const humanRows = (db: DatabaseSync) =>
    db.prepare("SELECT * FROM edge WHERE origin = 'human' ORDER BY id").all();
  const before = await inDb(humanRows);
  expect(before.length).toBeGreaterThan(0);
  await buildAgain();
  expect(await inDb(humanRows)).toEqual(before);
  expect(
    await inDb((db) => db.prepare('SELECT status FROM edge WHERE id = ?').get(edge.id)),
  ).toEqual({ status: 'confirmed' });
  expect(calls).toBe(2);
});

it('建圖重跑同一份引文，墓碑不復活、出處不增加', async () => {
  await buildAgain();
  const edge = await inDb(
    (db) =>
      db
        .prepare(
          "SELECT id FROM edge WHERE layer = 'named' AND origin = 'machine' AND rel = '測試關係'",
        )
        .get() as { id: string },
  );
  expect((await transitionEdge(root, slug, edge.id, 'reject')).ok).toBe(true);
  await buildAgain();
  expect(
    await inDb((db) => db.prepare('SELECT status FROM edge WHERE id = ?').get(edge.id)),
  ).toEqual({ status: 'rejected' });
  expect(
    await inDb((db) =>
      db.prepare('SELECT COUNT(*) AS count FROM edge_evidence WHERE edge_id = ?').get(edge.id),
    ),
  ).toEqual({ count: 1 });
  expect(calls).toBe(2);
});

it('建圖的引文找不到，不寫機器具名關聯並留下錯誤碼', async () => {
  quote = '這一句並不存在於任何測試正文裡面';
  await buildAgain();
  expect(
    await inDb((db) =>
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM edge WHERE layer = 'named' AND origin = 'machine' AND rel = '測試關係'",
        )
        .get(),
    ),
  ).toEqual({ count: 0 });
  const runId = (await view()).build.runId!;
  expect(
    await inDb(
      (db) => runs.listRunItems(db, runId).find((entry) => entry.itemId === itemIds[0])?.code,
    ),
  ).toBe('PROVIDER_QUOTE_NOT_FOUND');
});

it('建圖預設不記模型呼叫', async () => {
  await buildAgain();
  await expect(readdir(join(root, 'cases', slug, 'model-calls'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('逐任務模型真的送到抽取端點，紀錄保留提示詞、回覆與實際模型', async () => {
  const configPath = join(sandbox, 'local', 'Cyclosa', 'providers.json');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as {
    tasks: Record<string, { via: string; model: string }>;
    diagnostics: { logModelCalls: boolean };
  };
  config.tasks['digest'] = { via: 'ollama', model: 'different-digest' };
  config.tasks['extract'] = { via: 'ollama', model: 'fake-extract' };
  config.diagnostics.logModelCalls = true;
  await writeFile(configPath, JSON.stringify(config), 'utf8');
  await buildAgain();
  expect(calledModels).toEqual(['fake-extract']);
  const runId = (await view()).build.runId!;
  const lines = (await readFile(join(root, 'cases', slug, 'model-calls', `${runId}.jsonl`), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatchObject({
    task: 'extract',
    model: 'ollama:fake-extract',
    transport: 'ollama',
    endpoint: new URL(baseUrl).host,
    itemId: itemIds[0],
    outcome: { ok: true, code: null },
  });
  expect((lines[0]?.['request'] as { user: string }).user).toContain(quote);
  expect(JSON.stringify(lines[0]?.['response'])).toContain('測試關係');
});
