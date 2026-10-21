/** 研究與整理共用殼表，但各自的讀取與操作不可跨種類；D4 仍然共用。 */
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createCase } from '../../src/application/case-service.js';
import {
  abandonConsolidateShell,
  executeConsolidateShell,
  getConsolidateShell,
  planConsolidateShell,
  setConsolidateOpChecked,
  startConsolidateShell,
} from '../../src/application/consolidate-ops-service.js';
import {
  editCandidateDecision,
  finishBuilding,
  startBuilding,
} from '../../src/application/research-build.js';
import {
  finishCollecting,
  markCandidateUnavailable,
  reopenCandidate,
  resumeCollecting,
  uploadCandidate,
} from '../../src/application/research-collect.js';
import { assessResearchGap } from '../../src/application/research-gap.js';
import {
  abandonResearch,
  converse,
  deleteResearch,
  editDirections,
  getResearchView,
  listResearchViews,
  startCollecting,
  startResearch,
  type ProvidersLoader,
} from '../../src/application/research-service.js';
import { forgetSwept } from '../../src/application/run-sweep.js';
import type { ResearchKind, ResearchStatus } from '../../src/domain/research/index.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import * as research from '../../src/infrastructure/db/repositories/research-repo.js';
import type { Result } from '../../src/shared/result.js';

let sandbox: string;
let root: string;
let slug: string;
let savedLocalAppData: string | undefined;
const noProviders = vi.fn<ProvidersLoader>(async () => {
  throw new Error('種類錯誤時不可載入模型服務');
});

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-research-kind-'));
  root = join(sandbox, 'data');
  const local = join(sandbox, 'local');
  await mkdir(local);
  savedLocalAppData = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = local;
  forgetSwept();
  noProviders.mockClear();
  const created = await createCase(root, { name: '種類隔離測試' });
  if (!created.ok) throw new Error(created.code);
  slug = created.data.slug;
});

afterEach(async () => {
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  await rm(sandbox, { recursive: true, force: true });
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

function insert(db: DatabaseSync, id: string, kind: ResearchKind, status: ResearchStatus): void {
  research.insertResearch(db, {
    id,
    kind,
    topic: kind === 'research' ? '合成主題' : null,
    hitsJson: '[]',
    correlationId: 'kind-test',
    now: 1,
  });
  research.updateResearchStatus(db, id, status, 2);
}

async function snapshot() {
  return inDb((db) => ({
    row: research.getResearch(db, 'target'),
    messages: research.listMessages(db, 'target'),
    directions: research.listDirections(db, 'target'),
    candidates: research.listCandidates(db, 'target'),
    operations: db.prepare('SELECT * FROM consolidate_op').all(),
    runs: db.prepare('SELECT * FROM run').all(),
  }));
}

it('整理殼開著：研究清單空、開始研究與第二個整理殼都被 D4 擋住', async () => {
  const shell = await startConsolidateShell(root, slug);
  if (!shell.ok) throw new Error(shell.code);
  expect(await listResearchViews(root, slug)).toMatchObject({ ok: true, data: [] });
  expect(await startResearch(root, slug, { topic: '合成主題' }, noProviders)).toMatchObject({
    ok: false,
    code: 'RESEARCH_ALREADY_OPEN',
    detail: { researchId: shell.data.id },
  });
  expect(await startConsolidateShell(root, slug)).toMatchObject({
    ok: false,
    code: 'RESEARCH_ALREADY_OPEN',
  });
  expect(noProviders).not.toHaveBeenCalled();
});

it('研究開著：整理清單空、開始整理被擋；放棄研究後可以開始整理', async () => {
  const started = await startResearch(root, slug, { topic: '合成主題' });
  if (!started.ok) throw new Error(started.code);
  expect(await getConsolidateShell(root, slug)).toMatchObject({ ok: true, data: null });
  expect(await startConsolidateShell(root, slug)).toMatchObject({
    ok: false,
    code: 'RESEARCH_ALREADY_OPEN',
    detail: { researchId: started.data.id },
  });
  expect((await abandonResearch(root, slug, started.data.id)).ok).toBe(true);
  expect((await startConsolidateShell(root, slug)).ok).toBe(true);
});

it('先篩種類再取筆數，研究歷史不被整理擠掉，整理不被超過一百筆研究藏起來', async () => {
  await inDb((db) => {
    insert(db, 'old-shell', 'consolidate', 'done');
    for (let i = 0; i < 101; i += 1) insert(db, 'research-' + i, 'research', 'done');
  });
  expect(await getConsolidateShell(root, slug)).toMatchObject({
    ok: true,
    data: { id: 'old-shell' },
  });
  const started = await startConsolidateShell(root, slug);
  if (!started.ok) throw new Error(started.code);
  const listed = await listResearchViews(root, slug, 1);
  if (!listed.ok) throw new Error(listed.code);
  expect(listed.data.map((row) => row.id)).toEqual(['research-100']);
  expect((await abandonConsolidateShell(root, slug, started.data.id)).ok).toBe(true);
  expect((await startResearch(root, slug, { topic: '合成主題' })).ok).toBe(true);
});

it('研究建立入口不能用 kind 另開整理殼', async () => {
  expect(
    await startResearch(root, slug, { topic: '', kind: 'consolidate' }, noProviders),
  ).toMatchObject({
    ok: false,
    code: 'RESEARCH_STEP_INVALID',
    detail: { kind: 'consolidate', want: 'research' },
  });
  expect(await inDb((db) => research.openResearch(db))).toBeNull();
  expect(noProviders).not.toHaveBeenCalled();
});

type Action = readonly [string, ResearchStatus, () => Promise<Result<unknown>>];
const researchActions: readonly Action[] = [
  ['目前這一次', 'reviewing', () => getResearchView(root, slug, 'target', noProviders)],
  ['規劃對話', 'planning', () => converse(root, slug, 'target', '合成提問', noProviders)],
  ['修改方向', 'planning', () => editDirections(root, slug, 'target', [], noProviders)],
  ['確認規劃', 'planning', () => startCollecting(root, slug, 'target', noProviders)],
  ['放棄研究', 'planning', () => abandonResearch(root, slug, 'target', noProviders)],
  ['繼續蒐集', 'collecting', () => resumeCollecting(root, slug, 'target', noProviders)],
  ['完成蒐集', 'awaiting-user', () => finishCollecting(root, slug, 'target', noProviders)],
  [
    '上傳候選',
    'awaiting-user',
    () =>
      uploadCandidate(
        root,
        slug,
        'target',
        'candidate',
        { name: 'fixture.txt', bytes: new Uint8Array() },
        noProviders,
      ),
  ],
  [
    '標記拿不到',
    'awaiting-user',
    () =>
      markCandidateUnavailable(
        root,
        slug,
        'target',
        'candidate',
        { reason: 'not-found' },
        noProviders,
      ),
  ],
  [
    '重新開啟候選',
    'awaiting-user',
    () => reopenCandidate(root, slug, 'target', 'candidate', noProviders),
  ],
  ['缺口評估', 'reviewing', () => assessResearchGap(root, slug, 'target', noProviders)],
  [
    '候選決定',
    'reviewing',
    () =>
      editCandidateDecision(
        root,
        slug,
        'target',
        'candidate',
        { decision: 'include' },
        noProviders,
      ),
  ],
  ['開始建圖', 'reviewing', () => startBuilding(root, slug, 'target', noProviders)],
  ['完成建圖', 'building', () => finishBuilding(root, slug, 'target', noProviders)],
  ['刪除預覽', 'done', () => deleteResearch(root, slug, 'target')],
  ['確認刪除', 'done', () => deleteResearch(root, slug, 'target', true)],
];

it.each(researchActions)(
  '研究操作 %s 拒絕整理 ID，不改資料或載入模型',
  async (_name, status, act) => {
    await inDb((db) => insert(db, 'target', 'consolidate', status));
    const before = await snapshot();
    expect(await act()).toMatchObject({
      ok: false,
      code: 'RESEARCH_STEP_INVALID',
      detail: { kind: 'consolidate', want: 'research' },
    });
    expect(await snapshot()).toEqual(before);
    expect(noProviders).not.toHaveBeenCalled();
  },
);

const consolidateActions: readonly Action[] = [
  ['規劃', 'planning', () => planConsolidateShell(root, slug, 'target', noProviders)],
  ['勾選', 'reviewing', () => setConsolidateOpChecked(root, slug, 'target', 'operation', true)],
  ['執行', 'reviewing', () => executeConsolidateShell(root, slug, 'target', noProviders)],
  ['放棄', 'planning', () => abandonConsolidateShell(root, slug, 'target')],
];

it.each(consolidateActions)(
  '整理操作 %s 拒絕研究 ID，不改資料或載入模型',
  async (_name, status, act) => {
    await inDb((db) => insert(db, 'target', 'research', status));
    const before = await snapshot();
    expect(await act()).toMatchObject({
      ok: false,
      code: 'RESEARCH_STEP_INVALID',
      detail: { kind: 'research', want: 'consolidate' },
    });
    expect(await snapshot()).toEqual(before);
    expect(noProviders).not.toHaveBeenCalled();
  },
);
