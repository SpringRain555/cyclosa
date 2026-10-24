import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { createCase } from '../../src/application/case-service.js';
import {
  abandonConsolidateShell,
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
import { loadEdgesAmong } from '../../src/infrastructure/db/repositories/graph-repo.js';
import * as entities from '../../src/infrastructure/db/repositories/entity-repo.js';
import * as runs from '../../src/infrastructure/db/repositories/run-repo.js';
import { DEFAULT_CONFIG, parseConfig } from '../../src/infrastructure/providers/config.js';
import { EXTRACTOR_VERSION, writeDerived } from '../../src/infrastructure/fs/case-files.js';
import type { Providers } from '../../src/infrastructure/providers/registry.js';
import type { EmbedProvider } from '../../src/infrastructure/providers/embed-ollama.js';
import { nearbyEntityNames, mergeThresholdsOf } from '../../src/domain/entity/merge-candidates.js';
import type { ConsolidateOpDraft } from '../../src/domain/research/consolidate.js';

let root: string, slug: string, localBefore: string | undefined;
let prompt: { mergeCandidates: { keep: string; drop: string }[] };
let invented: boolean;
let planExtras: readonly ConsolidateOpDraft[];
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
          operations: [
            ...pairs.map((pair) => ({
              kind: 'merge',
              payload: { keep: pair.keep, drop: pair.drop },
              why: '合成資料的相同實體',
            })),
            ...planExtras,
          ],
        }),
        cost,
      };
    },
  }),
});

const loadWithoutEmbed = async (): Promise<Providers> => ({ ...(await load()), embed: null });

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
  planExtras = [];
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
  await writeDerived(join(root, 'cases', slug), 'item', {
    extractorVersion: EXTRACTOR_VERSION,
    kind: 'text',
    title: '合成來源',
    text: '合成來源正文，用於整理抽取與初讀建議。',
    html: null,
    pages: null,
    excerpt: '合成來源正文',
    lowConfidence: false,
    reasons: [],
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

it('沒設定嵌入時略過合併候選，其他提案照常保留且記錄丟棄原因', async () => {
  planExtras = [
    { kind: 'merge', payload: { keep: 'a', drop: 'b' }, why: '合成近似名稱配對' },
    { kind: 'extract', payload: { itemIds: ['item'] }, why: '補抽這份來源' },
    { kind: 'digest', payload: { itemIds: ['item'] }, why: '補繁中這份來源' },
  ];
  const opened = await startConsolidateShell(root, slug);
  if (!opened.ok) throw new Error(opened.code);
  const planned = await planConsolidateShell(root, slug, opened.data.id, loadWithoutEmbed);
  if (!planned.ok) throw new Error(planned.code);

  expect(prompt.mergeCandidates).toEqual([]);
  expect(planned.data.coverage).toMatchObject({
    mergeCandidatesIncluded: 0,
    mergeCandidatesAvailable: 0,
    mergeCandidatesSkipped: 'embed-not-configured',
  });
  expect(planned.data.operations.map((operation) => operation.kind).sort()).toEqual([
    'digest',
    'extract',
  ]);
  expect(planned.data.dropped).toMatchObject({
    count: 1,
    reasons: { 'merge-not-candidate': 1 },
  });
});

it('嵌入已設定但呼叫失敗時，整理規劃仍明確失敗', async () => {
  vi.mocked(embed.embedDocuments).mockResolvedValueOnce({
    kind: 'error',
    code: 'PROVIDER_UNREACHABLE',
    detail: 'synthetic offline provider',
    cost,
  });
  const opened = await startConsolidateShell(root, slug);
  if (!opened.ok) throw new Error(opened.code);
  expect(await planConsolidateShell(root, slug, opened.data.id, load)).toMatchObject({
    ok: false,
    code: 'PROVIDER_UNREACHABLE',
  });
  expect(embed.embedDocuments).toHaveBeenCalledOnce();
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

it('abandon aborts planning and ignores a late successful provider response', async () => {
  const opened = await startConsolidateShell(root, slug);
  if (!opened.ok) throw new Error(opened.code);
  let resolveCall!: () => void;
  let captured: AbortSignal | undefined;
  const base = await load();
  const delayed = async (): Promise<Providers> => ({
    ...base,
    planFor: () => ({
      name: 'delayed',
      probe: ready,
      run: async (_input, signal) => {
        captured = signal;
        await new Promise<void>((resolve) => {
          resolveCall = resolve;
        });
        return {
          kind: 'ok',
          value: JSON.stringify({
            operations: [{ kind: 'merge', payload: { keep: 'a', drop: 'b' }, why: 'synthetic' }],
          }),
          cost,
        };
      },
    }),
  });
  const pending = planConsolidateShell(root, slug, opened.data.id, delayed);
  await expect.poll(() => captured !== undefined).toBe(true);
  expect(await abandonConsolidateShell(root, slug, opened.data.id, delayed)).toMatchObject({
    ok: true,
  });
  expect(captured?.aborted).toBe(true);
  resolveCall();
  expect(await pending).toMatchObject({ ok: false, code: 'RESEARCH_STEP_INVALID' });
  const view = await getConsolidateShell(root, slug, load);
  expect(view).toMatchObject({ ok: true, data: { status: 'abandoned', operations: [] } });
});

it('abandon propagates cancellation through embedding and never starts the planner', async () => {
  const opened = await startConsolidateShell(root, slug);
  if (!opened.ok) throw new Error(opened.code);
  let captured: AbortSignal | undefined;
  const run = vi.fn();
  const base = await load();
  const delayed = async (): Promise<Providers> => ({
    ...base,
    embed: {
      ...embed,
      embedDocuments: async (_texts, signal) => {
        captured = signal;
        await new Promise<void>((resolve) =>
          signal!.addEventListener('abort', () => resolve(), { once: true }),
        );
        return { kind: 'error', code: 'PROVIDER_UNREACHABLE', detail: 'cancelled', cost };
      },
    },
    planFor: () => ({ name: 'unused', probe: ready, run }),
  });
  const pending = planConsolidateShell(root, slug, opened.data.id, delayed);
  await expect.poll(() => captured !== undefined).toBe(true);
  await abandonConsolidateShell(root, slug, opened.data.id, delayed);
  await pending;
  expect(captured?.aborted).toBe(true);
  expect(run).not.toHaveBeenCalled();
  expect(await getConsolidateShell(root, slug, load)).toMatchObject({
    ok: true,
    data: { status: 'abandoned' },
  });
});

it('兩個實體原本互相關聯時，合併不建立自連線；取消後原關聯與端點完整保留', async () => {
  await inDb((db) => {
    for (const [id, source, target] of [
      ['between-forward', 'a', 'b'],
      ['between-back', 'b', 'a'],
    ]) {
      db.prepare(
        `INSERT INTO edge (id,layer,rel,source_id,source_kind,target_id,target_kind,origin,status,created_at,updated_at)
        VALUES (?, 'named', '合成關係', ?, 'entity', ?, 'entity', 'human', 'confirmed', 1, 1)`,
      ).run(id!, source!, target!);
    }
  });
  const before = await inDb((db) =>
    db.prepare('SELECT id, source_id, target_id, status FROM edge ORDER BY id').all(),
  );
  expect(await mergeEntity(root, slug, 'a', 'b')).toMatchObject({ ok: true });
  expect(
    await inDb((db) =>
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM edge WHERE source_id=target_id AND source_kind=target_kind',
        )
        .get(),
    ),
  ).toMatchObject({ n: 0 });
  expect(
    await inDb((db) =>
      db
        .prepare('SELECT id,source_id,target_id FROM edge WHERE id LIKE ? ORDER BY id')
        .all('between-%'),
    ),
  ).toEqual([
    { id: 'between-back', source_id: 'b', target_id: 'a' },
    { id: 'between-forward', source_id: 'a', target_id: 'b' },
  ]);
  const visiblePairEdges = () =>
    inDb((db) =>
      loadEdgesAmong(db, new Set(['a', 'b']), {
        kinds: [],
        statuses: [],
        layers: [],
        minTier: null,
        since: null,
        until: null,
      }),
    );
  expect(await visiblePairEdges()).toHaveLength(0);
  expect(await unmergeEntity(root, slug, 'b')).toMatchObject({ ok: true });
  expect(await visiblePairEdges()).toHaveLength(2);
  expect(
    await inDb((db) =>
      db.prepare('SELECT id, source_id, target_id, status FROM edge ORDER BY id').all(),
    ),
  ).toEqual(before);
});

it('取消合併移除本次吸收的別名，保留原別名與後來新增的別名，重抽可對回原實體', async () => {
  await inDb((db) => {
    entities.addAlias(db, 'a', '虛構原別名', 1);
    entities.addAlias(db, 'b', '虛構吸收別名', 1);
  });
  expect((await mergeEntity(root, slug, 'a', 'b')).ok).toBe(true);
  await inDb((db) => entities.addAlias(db, 'a', '虛構後續別名', 2));
  expect((await unmergeEntity(root, slug, 'b')).ok).toBe(true);
  await inDb((db) => {
    expect(entities.getEntity(db, 'a')?.aliases).toEqual(['虛構原別名', '虛構後續別名']);
    expect(entities.findEntityFor(entities.listEntities(db), '合成研究中芯', 'org')?.id).toBe('b');
    expect(entities.findEntityFor(entities.listEntities(db), '虛構吸收別名', 'org')?.id).toBe('b');
  });
});
it('已吸收其他實體的保留者不可再被吸收，避免產生合併鏈', async () => {
  expect((await mergeEntity(root, slug, 'a', 'b')).ok).toBe(true);
  expect(await mergeEntity(root, slug, 'c', 'a')).toMatchObject({
    ok: false,
    code: 'GRAPH_TRANSITION_INVALID',
  });
});
it('同一保留者多次合併必須逆序取消，避免互相覆寫端點', async () => {
  expect((await mergeEntity(root, slug, 'a', 'b')).ok).toBe(true);
  expect((await mergeEntity(root, slug, 'a', 'c')).ok).toBe(true);
  expect((await unmergeEntity(root, slug, 'b')).ok).toBe(false);
  expect((await unmergeEntity(root, slug, 'c')).ok).toBe(true);
  expect((await unmergeEntity(root, slug, 'b')).ok).toBe(true);
});
it('封存專題禁止直接合併、取消合併及整理勾選和執行', async () => {
  const shell = await planned();
  const operation = shell.operations.find((op) => op.kind === 'merge')!;
  expect((await setConsolidateOpChecked(root, slug, shell.id, operation.id, true)).ok).toBe(true);
  await inDb((db) => db.exec(`UPDATE "case" SET status='archived'`));
  expect(await mergeEntity(root, slug, 'a', 'b')).toMatchObject({
    ok: false,
    code: 'CASE_ARCHIVED',
  });
  expect(await unmergeEntity(root, slug, 'b')).toMatchObject({ ok: false, code: 'CASE_ARCHIVED' });
  expect(await setConsolidateOpChecked(root, slug, shell.id, operation.id, true)).toMatchObject({
    ok: false,
    code: 'CASE_ARCHIVED',
  });
  expect(await executeConsolidateShell(root, slug, shell.id, load)).toMatchObject({
    ok: false,
    code: 'CASE_ARCHIVED',
  });
});

it('取消舊合併的延遲請求不能取消同一實體後來的新合併', async () => {
  expect((await mergeEntity(root, slug, 'a', 'b')).ok).toBe(true);
  const oldId = await inDb((db) => entities.activeMergeId(db, 'b'));
  expect((await unmergeEntity(root, slug, 'b', oldId!)).ok).toBe(true);
  expect((await mergeEntity(root, slug, 'a', 'b')).ok).toBe(true);
  expect((await unmergeEntity(root, slug, 'b', oldId!)).ok).toBe(false);
  expect(await inDb((db) => entities.getEntity(db, 'b')?.mergedInto)).toBe('a');
});
it('損壞的移動紀錄不清掉合併指向，也不修改任何邊', async () => {
  expect((await mergeEntity(root, slug, 'a', 'b')).ok).toBe(true);
  await inDb((db) => db.exec("UPDATE entity_merge SET moved_json='invalid' WHERE merged_id='b'"));
  expect((await unmergeEntity(root, slug, 'b')).ok).toBe(false);
  await inDb((db) => {
    expect(entities.getEntity(db, 'b')?.mergedInto).toBe('a');
    expect(db.prepare("SELECT target_id FROM edge WHERE id='edge'").get()).toMatchObject({
      target_id: 'a',
    });
  });
});
it('等待服務時重複送出，只會建立一筆合併作業', async () => {
  const shell = await planned();
  const op = shell.operations.find((entry) => entry.kind === 'merge')!;
  expect((await setConsolidateOpChecked(root, slug, shell.id, op.id, true)).ok).toBe(true);
  const providers = await load();
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = async () => {
    arrived++;
    await gate;
    return providers;
  };
  const first = executeConsolidateShell(root, slug, shell.id, waiting);
  const second = executeConsolidateShell(root, slug, shell.id, waiting);
  await expect.poll(() => arrived).toBe(2);
  release();
  expect((await Promise.all([first, second])).filter((r) => r.ok)).toHaveLength(1);
  await expect.poll(activeCount).toBe(0);
});
it.each(['archive', 'uncheck', 'abandon'] as const)(
  '等待服務期間 %s 後不會使用舊選擇執行合併',
  async (action) => {
    const shell = await planned();
    const op = shell.operations.find((entry) => entry.kind === 'merge')!;
    expect((await setConsolidateOpChecked(root, slug, shell.id, op.id, true)).ok).toBe(true);
    const providers = await load();
    let arrived = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = executeConsolidateShell(root, slug, shell.id, async () => {
      arrived = true;
      await gate;
      return providers;
    });
    await expect.poll(() => arrived).toBe(true);
    if (action === 'abandon') await abandonConsolidateShell(root, slug, shell.id);
    else
      await inDb((db) => {
        if (action === 'archive') db.exec(`UPDATE "case" SET status='archived'`);
        else db.prepare('UPDATE consolidate_op SET checked=0 WHERE id=?').run(op.id);
      });
    release();
    expect((await pending).ok).toBe(false);
    expect(
      await inDb((db) => entities.listEntities(db).filter((e) => e.mergedInto !== null)),
    ).toHaveLength(0);
  },
);

it('保留舊版 moved_json 陣列格式，沒有別名快照的舊紀錄仍可取消且不猜測刪別名', async () => {
  expect((await mergeEntity(root, slug, 'a', 'b')).ok).toBe(true);
  await inDb((db) => {
    const record = db.prepare("SELECT moved_json FROM entity_merge WHERE merged_id='b'").get() as {
      moved_json: string;
    };
    expect(Array.isArray(JSON.parse(record.moved_json))).toBe(true);
    db.exec("UPDATE entity_merge SET reason='manual' WHERE merged_id='b'");
  });
  expect((await unmergeEntity(root, slug, 'b')).ok).toBe(true);
  await inDb((db) =>
    expect(entities.findEntityFor(entities.listEntities(db), '合成研究中芯', 'org')?.id).toBe('b'),
  );
});

it('合併後新增給保留者的關聯不會在取消時被搬走', async () => {
  expect((await mergeEntity(root, slug, 'a', 'b')).ok).toBe(true);
  await inDb((db) =>
    db.exec(
      "INSERT INTO edge (id,layer,rel,source_id,source_kind,target_id,target_kind,origin,status,confidence,created_at,updated_at) VALUES ('later','comention','提到','item','item','a','entity','machine','pending',1,2,2)",
    ),
  );
  expect((await unmergeEntity(root, slug, 'b')).ok).toBe(true);
  await inDb((db) => {
    expect(db.prepare("SELECT target_id FROM edge WHERE id='edge'").get()).toMatchObject({
      target_id: 'b',
    });
    expect(db.prepare("SELECT target_id FROM edge WHERE id='later'").get()).toMatchObject({
      target_id: 'a',
    });
  });
});
it('移動過的端點被後續改動時，取消失效而不是覆寫後來的端點', async () => {
  expect((await mergeEntity(root, slug, 'a', 'b')).ok).toBe(true);
  await inDb((db) => db.exec("UPDATE edge SET target_id='c' WHERE id='edge'"));
  expect((await unmergeEntity(root, slug, 'b')).ok).toBe(false);
  await inDb((db) => {
    expect(entities.getEntity(db, 'b')?.mergedInto).toBe('a');
    expect(db.prepare("SELECT target_id FROM edge WHERE id='edge'").get()).toMatchObject({
      target_id: 'c',
    });
  });
});
