import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createCase } from '../../src/application/case-service.js';
import {
  startConsolidateShell,
  planConsolidateShell,
  setConsolidateOpChecked,
  executeConsolidateShell,
  getConsolidateShell,
} from '../../src/application/consolidate-ops-service.js';
import { semanticMergeCandidates } from '../../src/application/entity-merge-candidates.js';
import {
  mergeEntity,
  unmergeEntity,
  listMergedEntities,
} from '../../src/application/entity-service.js';
import { activeCount, cancelAll } from '../../src/application/run-registry.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import * as entities from '../../src/infrastructure/db/repositories/entity-repo.js';
import * as runs from '../../src/infrastructure/db/repositories/run-repo.js';
import { DEFAULT_CONFIG, parseConfig } from '../../src/infrastructure/providers/config.js';
import type { Providers } from '../../src/infrastructure/providers/registry.js';
import type { EmbedProvider } from '../../src/infrastructure/providers/embed-ollama.js';
import { nearbyEntityNames, mergeThresholdsOf } from '../../src/domain/entity/merge-candidates.js';

let root: string, slug: string, localBefore: string | undefined;
let prompt: { mergeCandidates: { keep: string; drop: string }[] };
let invented: boolean;
const cost = { elapsedMs: 1, costUsd: 0 };
const ready = async () => ({
  kind: 'ready' as const,
  model: 'synthetic',
  version: null,
  capabilities: {
    browse: false,
    tools: false,
    json_schema: true,
    vision: false,
    context_tokens: 10000,
  },
});
const embed: EmbedProvider = {
  name: 'synthetic',
  model: 'synthetic',
  probe: ready,
  embedQuery: async () => ({ kind: 'ok', value: new Float32Array([1, 0]), cost }),
  embedDocuments: vi.fn(async (texts: readonly string[]) => ({
    kind: 'ok' as const,
    value: {
      dim: 2,
      vectors: texts.map((text) => new Float32Array(text.includes('醫院') ? [0, 1] : [1, 0])),
    },
    cost,
  })),
};
const load = async (): Promise<Providers> => ({
  config: { ...DEFAULT_CONFIG, mergeCandidates: { maxNameDistance: 2, minSimilarity: 0.97 } },
  embed,
  chatFor: () => {
    throw new Error('僅合併不可要求抽取模型');
  },
  agentFor: () => null,
  planChat: () => null,
  connectionOf: () => ({ via: 'ollama', baseUrl: null }),
  planFor: () => ({
    name: 'synthetic-plan',
    probe: ready,
    run: async (input) => {
      prompt = JSON.parse(input.prompt) as typeof prompt;
      const pairs = invented
        ? [...prompt.mergeCandidates, { keep: 'a', drop: 'hospital' }]
        : prompt.mergeCandidates;
      return {
        kind: 'ok',
        value: JSON.stringify({
          operations: pairs.map((pair) => ({
            kind: 'merge',
            payload: { keep: pair.keep, drop: pair.drop },
            why: '合成資料的相同實體',
          })),
        }),
        cost,
      };
    },
  }),
});

async function inDb<T>(body: (db: DatabaseSync) => T): Promise<T> {
  const opened = await openCaseDatabase(join(root, 'cases', slug, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(opened.kind);
  try {
    return body(opened.db);
  } finally {
    opened.db.close();
  }
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cyclosa-merge-'));
  localBefore = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(root, 'local');
  await mkdir(join(root, 'local'));
  invented = false;
  vi.mocked(embed.embedDocuments).mockClear();
  const created = await createCase(root, { name: '合成合併驗收' });
  if (!created.ok) throw new Error(created.code);
  slug = created.data.slug;
  await inDb((db) => {
    for (const [id, name] of [
      ['a', '合成研究中心'],
      ['b', '合成研究中芯'],
      ['hospital', '合成研究醫院'],
      ['c', '第二測試組織'],
      ['d', '第二測試組職'],
    ]) {
      entities.insertEntity(db, { id: id!, name: name!, type: 'org', now: 1 });
    }
    db.prepare(
      "INSERT INTO item (id, kind, title, title_rank, lang, status, created_at, updated_at) VALUES ('item', 'text', '合成來源', '合成來源', 'und', 'included', 0, 0)",
    ).run();
    db.prepare(
      "INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind, origin, status, confidence, created_at, updated_at) VALUES ('edge', 'comention', '提到', 'item', 'item', 'b', 'entity', 'machine', 'pending', 1, 0, 0)",
    ).run();
  });
});
afterEach(async () => {
  cancelAll();
  await expect.poll(activeCount).toBe(0);
  if (localBefore === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = localBefore;
  await rm(root, { recursive: true, force: true });
});

async function planned() {
  const opened = await startConsolidateShell(root, slug);
  if (!opened.ok) throw new Error(opened.code);
  const planned = await planConsolidateShell(root, slug, opened.data.id, load);
  if (!planned.ok) throw new Error(planned.code);
  return planned.data;
}

it('兩道門檻都過才交給模型，模型自行加的配對也被丟棄；預設不勾、不合併', async () => {
  invented = true;
  const shell = await planned();
  expect(prompt.mergeCandidates).toHaveLength(2);
  expect(
    prompt.mergeCandidates.some((pair) => pair.keep === 'hospital' || pair.drop === 'hospital'),
  ).toBe(false);
  expect(shell.operations).toHaveLength(2);
  expect(shell.operations.every((op) => !op.checked && op.executable)).toBe(true);
  expect(shell.dropped.reasons['merge-not-candidate']).toBe(1);
  expect(await executeConsolidateShell(root, slug, shell.id, load)).toMatchObject({
    ok: false,
    code: 'CONSOLIDATE_SELECTION_INVALID',
  });
  expect(await inDb((db) => entities.getEntity(db, 'a')?.mergedInto)).toBeNull();
});

it('只勾一對就只合併那一對，僅合併不需要抽取模型；取消可還原關聯', async () => {
  const shell = await planned();
  const operation = shell.operations.find(
    (op) => (op.payload as { keep: string; drop: string }).keep === 'b',
  )!;
  // b 被來源提到較多，保留 b；把原本 b 的邊改到 a，以驗證取消時實際搬回。
  await inDb((db) => db.prepare("UPDATE edge SET target_id = 'a' WHERE id = 'edge'").run());
  expect(await setConsolidateOpChecked(root, slug, shell.id, operation.id, true)).toMatchObject({
    ok: true,
  });
  const started = await executeConsolidateShell(root, slug, shell.id, load);
  if (!started.ok) throw new Error(started.code);
  await expect.poll(activeCount).toBe(0);
  const view = await getConsolidateShell(root, slug, load);
  expect(view).toMatchObject({ ok: true, data: { status: 'done' } });
  expect(view.ok && view.data?.operations.find((op) => op.id === operation.id)).toMatchObject({
    state: 'done',
    undo: { mergedId: 'a' },
  });
  expect(await inDb((db) => entities.getEntity(db, 'a')?.mergedInto)).toBe('b');
  expect(await inDb((db) => entities.getEntity(db, 'd')?.mergedInto)).toBeNull();
  expect(await listMergedEntities(root, slug, 'b')).toMatchObject({
    ok: true,
    data: [{ id: 'a' }],
  });
  expect(await unmergeEntity(root, slug, 'a')).toMatchObject({ ok: true, data: { restored: 1 } });
  expect(
    await inDb((db) => db.prepare("SELECT target_id FROM edge WHERE id = 'edge'").get()),
  ).toMatchObject({ target_id: 'a' });
  expect(await inDb((db) => runs.getRun(db, started.data.runId))).toMatchObject({
    status: 'done',
    requests: 0,
    total: 1,
  });
});

it('勾選後實體被合併，執行時標為 stale，其餘勾選仍成功', async () => {
  const shell = await planned();
  for (const op of shell.operations)
    expect((await setConsolidateOpChecked(root, slug, shell.id, op.id, true)).ok).toBe(true);
  expect((await mergeEntity(root, slug, 'b', 'a')).ok).toBe(true);
  const started = await executeConsolidateShell(root, slug, shell.id, load);
  if (!started.ok) throw new Error(started.code);
  await expect.poll(activeCount).toBe(0);
  const view = await getConsolidateShell(root, slug, load);
  expect(view.ok && view.data?.operations.map((op) => op.state).sort()).toEqual(['done', 'stale']);
  expect(await inDb((db) => runs.getRun(db, started.data.runId)?.status)).toBe('partial');
});

it('名稱門檻先擋遠名、型別不同與已合併，沒候選時不呼叫嵌入', async () => {
  const rows = [
    { id: 'x', name: '合成中心', type: 'org' },
    { id: 'y', name: '完全不同的長名稱', type: 'org' },
    { id: 'z', name: '合成中心', type: 'person' },
    { id: 'w', name: '合成中心', type: 'org', mergedInto: 'x' },
  ];
  expect(nearbyEntityNames(rows, 1)).toEqual([]);
  expect(
    await semanticMergeCandidates(rows, new Map(), { maxNameDistance: 1, minSimilarity: 0 }, embed),
  ).toMatchObject({ ok: true, data: [] });
  expect(embed.embedDocuments).not.toHaveBeenCalled();
});

it('設定值可儲存，遺漏與無效門檻採預設；嵌入沒設定時明確報錯', async () => {
  expect(mergeThresholdsOf(null)).toEqual({ maxNameDistance: 5, minSimilarity: 0.97 });
  expect(mergeThresholdsOf({ maxNameDistance: -1, minSimilarity: NaN })).toEqual(
    mergeThresholdsOf(null),
  );
  const config = parseConfig({
    ...DEFAULT_CONFIG,
    mergeCandidates: { maxNameDistance: 0, minSimilarity: 1 },
  });
  expect(parseConfig(JSON.parse(JSON.stringify(config))).mergeCandidates).toEqual({
    maxNameDistance: 0,
    minSimilarity: 1,
  });
  const rows = [
    { id: 'a', name: '測試中心', type: 'org' },
    { id: 'b', name: '測試中芯', type: 'org' },
  ];
  expect(
    await semanticMergeCandidates(rows, new Map(), mergeThresholdsOf(null), null),
  ).toMatchObject({ ok: false, code: 'PROVIDER_NOT_CONFIGURED' });
});

it('個別合併寫入被人工保護規則拒絕時回滾，其他操作仍完成', async () => {
  const shell = await planned();
  for (const op of shell.operations) {
    expect((await setConsolidateOpChecked(root, slug, shell.id, op.id, true)).ok).toBe(true);
  }
  await inDb((db) => {
    db.prepare("UPDATE edge SET target_id = 'a' WHERE id = 'edge'").run();
    db.prepare(
      "INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind, origin, status, confidence, created_at, updated_at) VALUES ('protected', 'named', '人工關係', 'item', 'item', 'a', 'entity', 'human', 'confirmed', 1, 0, 0)",
    ).run();
  });
  const started = await executeConsolidateShell(root, slug, shell.id, load);
  if (!started.ok) throw new Error(started.code);
  await expect.poll(activeCount).toBe(0);
  const view = await getConsolidateShell(root, slug, load);
  expect(view.ok && view.data?.operations.map((op) => op.state).sort()).toEqual(['done', 'failed']);
  await inDb((db) => {
    expect(entities.getEntity(db, 'a')?.mergedInto).toBeNull();
    expect(db.prepare("SELECT target_id FROM edge WHERE id = 'edge'").get()).toMatchObject({
      target_id: 'a',
    });
    expect(runs.getRun(db, started.data.runId)?.status).toBe('partial');
  });
});

it('規劃後型別改變，在勾選時標成失效，不接受執行', async () => {
  const shell = await planned();
  const op = shell.operations.find((op) => (op.payload as { keep: string }).keep === 'b')!;
  await inDb((db) => db.prepare("UPDATE entity SET type = 'person' WHERE id = 'a'").run());
  expect(await setConsolidateOpChecked(root, slug, shell.id, op.id, true)).toMatchObject({
    ok: false,
    code: 'CONSOLIDATE_OP_STALE',
  });
});

it('門檻可排除語意相同但名稱太遠的配對，維度或零向量錯誤不可當候選', async () => {
  const rows = [
    { id: 'a', name: '測試中心', type: 'org' },
    { id: 'b', name: '測試中芯', type: 'org' },
  ];
  expect(
    await semanticMergeCandidates(rows, new Map(), { maxNameDistance: 0, minSimilarity: 0 }, embed),
  ).toMatchObject({ ok: true, data: [] });
  expect(embed.embedDocuments).not.toHaveBeenCalled();
  for (const vector of [
    new Float32Array([1]),
    new Float32Array([0, 0]),
    new Float32Array([NaN, 1]),
  ]) {
    vi.mocked(embed.embedDocuments).mockResolvedValueOnce({
      kind: 'ok',
      value: { dim: 2, vectors: [new Float32Array([1, 0]), vector] },
      cost,
    });
    expect(
      await semanticMergeCandidates(rows, new Map(), mergeThresholdsOf(null), embed),
    ).toMatchObject({ ok: false, code: 'PROVIDER_EMBED_MODEL_MISMATCH' });
  }
});
