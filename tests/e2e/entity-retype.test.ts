import { deleteOrphanEntities } from '../../src/infrastructure/db/repositories/run-repo.js';
import { loadProviders } from '../../src/infrastructure/providers/registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createCase } from '../../src/application/case-service.js';
import {
  startConsolidateShell,
  setConsolidateOpChecked,
  executeConsolidateShell,
} from '../../src/application/consolidate-ops-service.js';
import { entityTypeHistory, undoEntityType } from '../../src/application/entity-type-service.js';
import { applyExtraction } from '../../src/application/extraction-service.js';
import { executeRetypeOperation } from '../../src/application/consolidate-ops/retype.js';
import { activeCount } from '../../src/application/run-registry.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import * as entities from '../../src/infrastructure/db/repositories/entity-repo.js';
import * as ops from '../../src/infrastructure/db/repositories/consolidate-op-repo.js';
import * as research from '../../src/infrastructure/db/repositories/research-repo.js';
import type { EntityType } from '../../src/domain/provider/relations.js';
let root = '';
let slug = '';
let saved: string | undefined;
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
  root = await mkdtemp(join(tmpdir(), 'cyclosa-retype-'));
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(root, 'local');
  const created = await createCase(root, { name: '合成型別驗收' });
  if (!created.ok) throw new Error(created.code);
  slug = created.data.slug;
  await inDb((db) => {
    entities.insertEntity(db, { id: 'e', name: '合成晨光', type: 'concept', now: 1 });
    entities.addAlias(db, 'e', '合成晨光別名', 2);
    db.exec(
      "INSERT INTO item(id, kind, title, status, created_at, updated_at) VALUES ('i','text','合成資料','included',1,1)",
    );
    db.exec(
      "INSERT INTO run(id,kind,status,correlation_id,created_at) VALUES ('extract-run','extract','done','cid',1)",
    );
  });
});
afterEach(async () => {
  await expect.poll(activeCount).toBe(0);
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(root, { recursive: true, force: true });
});
async function propose(to: EntityType, id: string, entityId = 'e'): Promise<string> {
  const started = await startConsolidateShell(root, slug);
  if (!started.ok) throw new Error(started.code);
  await inDb((db) => {
    research.updateResearchStatus(db, started.data.id, 'reviewing', Date.now());
    ops.insertOp(db, {
      id,
      researchId: started.data.id,
      ord: 0,
      kind: 'retype',
      payloadJson: JSON.stringify({ entityId, to }),
      why: '合成理由',
    });
  });
  return started.data.id;
}
async function execute(to: EntityType, id: string): Promise<void> {
  const shell = await propose(to, id);
  expect((await setConsolidateOpChecked(root, slug, shell, id, true)).ok).toBe(true);
  const result = await executeConsolidateShell(root, slug, shell);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  await expect.poll(activeCount).toBe(0);
}
it('人工勾選才改型別；不需要抽取模型，保留紀錄；重抽舊型別與別名仍對回同一實體', async () => {
  const shell = await propose('org', 'op');
  await inDb((db) => {
    expect(ops.getOp(db, 'op')?.checked).toBe(false);
    expect(entities.getEntity(db, 'e')?.type).toBe('concept');
  });
  expect((await setConsolidateOpChecked(root, slug, shell, 'op', true)).ok).toBe(true);
  expect((await executeConsolidateShell(root, slug, shell)).ok).toBe(true);
  await expect.poll(activeCount).toBe(0);
  await inDb((db) => {
    const operation = ops.getOp(db, 'op');
    expect(operation?.state).toBe('done');
    expect(JSON.parse(operation?.undoJson ?? 'null')).toMatchObject({
      from: 'concept',
      fromManual: false,
      to: 'org',
    });
    applyExtraction(db, 'i', 'extract-run', '合成正文', {
      entities: [{ name: '合成晨光別名', type: 'concept' }],
      relations: [],
      dropped: { unknownEntity: 0, selfRelation: 0, duplicate: 0 },
    });
    expect(entities.listEntities(db)).toHaveLength(1);
    expect(entities.getEntity(db, 'e')).toMatchObject({ type: 'org', typeManual: true });
    expect(db.prepare("SELECT target_id FROM edge WHERE source_id = 'i'").get()).toMatchObject({
      target_id: 'e',
    });
  });
  expect((await undoEntityType(root, slug, 'e', 'op')).ok).toBe(true);
  await inDb((db) =>
    expect(entities.getEntity(db, 'e')).toMatchObject({ type: 'concept', typeManual: false }),
  );
  expect((await undoEntityType(root, slug, 'e', 'op')).ok).toBe(false);
});
it('連續人工修改依序退，舊請求不能蓋掉較新決定，退一層保留原人工標記', async () => {
  await execute('org', 'first');
  await execute('person', 'second');
  expect((await undoEntityType(root, slug, 'e', 'first')).ok).toBe(false);
  const history = await entityTypeHistory(root, slug, 'e');
  expect(history.ok && history.data.changes.filter((c) => c.canUndo).map((c) => c.opId)).toEqual([
    'second',
  ]);
  expect((await undoEntityType(root, slug, 'e', 'second')).ok).toBe(true);
  await inDb((db) =>
    expect(entities.getEntity(db, 'e')).toMatchObject({ type: 'org', typeManual: true }),
  );
  expect((await undoEntityType(root, slug, 'e', 'first')).ok).toBe(true);
});
it('勾選後被合併的提案標 stale，其他提案繼續，且不寫型別', async () => {
  const shell = await propose('org', 'stale');
  expect((await setConsolidateOpChecked(root, slug, shell, 'stale', true)).ok).toBe(true);
  await inDb((db) => {
    entities.insertEntity(db, { id: 'other', name: '另一個合成實體', type: 'concept', now: 1 });
    db.exec("UPDATE entity SET merged_into = 'other' WHERE id = 'e'");
    ops.insertOp(db, {
      id: 'valid',
      researchId: shell,
      ord: 1,
      kind: 'retype',
      payloadJson: JSON.stringify({ entityId: 'other', to: 'org' }),
      why: '合成理由',
    });
  });
  expect((await setConsolidateOpChecked(root, slug, shell, 'valid', true)).ok).toBe(true);
  expect((await executeConsolidateShell(root, slug, shell)).ok).toBe(true);
  await expect.poll(activeCount).toBe(0);
  await inDb((db) => {
    expect(ops.getOp(db, 'stale')).toMatchObject({ state: 'stale', code: 'CONSOLIDATE_OP_STALE' });
    expect(ops.getOp(db, 'valid')?.state).toBe('done');
    expect(entities.getEntity(db, 'e')?.type).toBe('concept');
    expect(entities.getEntity(db, 'other')?.type).toBe('org');
  });
});
it('紀錄寫入失敗時整次型別修改回滾', async () => {
  await inDb((db) => {
    expect(() =>
      executeRetypeOperation({
        db,
        entityId: 'e',
        to: 'org',
        completed: () => {
          throw new Error('合成寫入錯誤');
        },
      }),
    ).toThrow();
    expect(entities.getEntity(db, 'e')).toMatchObject({ type: 'concept', typeManual: false });
  });
});

it('其他作業清理孤立實體時保留人工改型別者，普通孤立實體仍可清理', async () => {
  await execute('org', 'manual');
  await inDb((db) => {
    entities.insertEntity(db, { id: 'plain', name: '合成殘留', type: 'concept', now: 1 });
    expect(deleteOrphanEntities(db)).toBe(1);
    expect(entities.getEntity(db, 'e')).toMatchObject({ type: 'org', typeManual: true });
    expect(entities.getEntity(db, 'plain')).toBeNull();
  });
  expect((await undoEntityType(root, slug, 'e', 'manual')).ok).toBe(true);
});
it('人工改型別者被合併後，重抽舊型別仍對回保留實體；取消合併後對回原實體', async () => {
  await execute('org', 'manual');
  await inDb((db) => {
    entities.insertEntity(db, { id: 'keep', name: '合成保留實體', type: 'org', now: 1 });
    entities.mergeEntities(db, {
      id: 'merge',
      keptId: 'keep',
      mergedId: 'e',
      reason: '合成驗收',
      now: 2,
    });
    expect(entities.findEntityFor(entities.listEntities(db), '合成晨光別名', 'concept')?.id).toBe(
      'keep',
    );
    entities.unmergeEntity(db, 'e', 3);
    expect(entities.findEntityFor(entities.listEntities(db), '合成晨光別名', 'concept')?.id).toBe(
      'e',
    );
  });
});
it('封存後，舊畫面不能再勾選、執行或復原型別', async () => {
  const shell = await propose('org', 'op');
  expect((await setConsolidateOpChecked(root, slug, shell, 'op', true)).ok).toBe(true);
  await inDb((db) => db.exec(`UPDATE "case" SET status='archived'`));
  expect(await setConsolidateOpChecked(root, slug, shell, 'op', true)).toMatchObject({
    ok: false,
    code: 'CASE_ARCHIVED',
  });
  expect(await executeConsolidateShell(root, slug, shell)).toMatchObject({
    ok: false,
    code: 'CASE_ARCHIVED',
  });
  expect(await undoEntityType(root, slug, 'e', 'op')).toMatchObject({
    ok: false,
    code: 'CASE_ARCHIVED',
  });
  await inDb((db) => expect(entities.getEntity(db, 'e')?.type).toBe('concept'));
});
it('等候服務設定時重複送出，只會開一筆整理作業', async () => {
  const shell = await propose('org', 'op');
  expect((await setConsolidateOpChecked(root, slug, shell, 'op', true)).ok).toBe(true);
  const providers = await loadProviders();
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const load = async () => {
    arrived++;
    await gate;
    return providers;
  };
  const first = executeConsolidateShell(root, slug, shell, load);
  const second = executeConsolidateShell(root, slug, shell, load);
  await expect.poll(() => arrived).toBe(2);
  release();
  const results = await Promise.all([first, second]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  await expect.poll(activeCount).toBe(0);
  await inDb((db) =>
    expect(
      db.prepare("SELECT count(*) AS n FROM run WHERE kind='consolidate'").get(),
    ).toMatchObject({ n: 1 }),
  );
});
it('勾選後另外復原人工決定，舊提案標 stale，不會蓋掉後來的決定', async () => {
  await execute('org', 'first');
  const shell = await propose('person', 'later');
  expect((await setConsolidateOpChecked(root, slug, shell, 'later', true)).ok).toBe(true);
  expect((await undoEntityType(root, slug, 'e', 'first')).ok).toBe(true);
  expect((await executeConsolidateShell(root, slug, shell)).ok).toBe(true);
  await expect.poll(activeCount).toBe(0);
  await inDb((db) => {
    expect(ops.getOp(db, 'later')).toMatchObject({ state: 'stale' });
    expect(entities.getEntity(db, 'e')).toMatchObject({ type: 'concept', typeManual: false });
  });
});

it.each(['archive', 'uncheck', 'abandon'] as const)(
  '等待服務檢查期間 %s，執行回來必須停止而不改型別',
  async (action) => {
    const shell = await propose('org', 'op');
    expect((await setConsolidateOpChecked(root, slug, shell, 'op', true)).ok).toBe(true);
    const providers = await loadProviders();
    let arrived = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = executeConsolidateShell(root, slug, shell, async () => {
      arrived = true;
      await gate;
      return providers;
    });
    await expect.poll(() => arrived).toBe(true);
    await inDb((db) => {
      if (action === 'archive') db.exec(`UPDATE "case" SET status='archived'`);
      else if (action === 'uncheck') ops.setChecked(db, 'op', false);
      else research.updateResearchStatus(db, shell, 'abandoned', Date.now());
    });
    release();
    expect((await pending).ok).toBe(false);
    await inDb((db) => {
      expect(entities.getEntity(db, 'e')).toMatchObject({ type: 'concept', typeManual: false });
      expect(
        db.prepare("SELECT count(*) AS n FROM run WHERE kind='consolidate'").get(),
      ).toMatchObject({ n: 0 });
    });
  },
);
