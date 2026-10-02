import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { applyMigration } from '../../src/infrastructure/db/database.js';
import { cleanupExpansion } from '../../src/infrastructure/db/cleanup-expansion.js';
import {
  insertEntity,
  addAlias,
  mergeEntities,
  unmergeEntity,
} from '../../src/infrastructure/db/repositories/entity-repo.js';
import { applyExtraction } from '../../src/application/extraction-service.js';
import { normalizeExtraction } from '../../src/domain/provider/index.js';

let db: DatabaseSync;

beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const folder = new URL('../../src/infrastructure/db/migrations/', import.meta.url);
  for (const file of (await readdir(folder)).filter((entry) => entry.endsWith('.sql')).sort()) {
    const version = Number(file.slice(0, 3));
    if (version <= 12) applyMigration(db, await readFile(new URL(file, folder), 'utf8'), version);
  }
  db.exec(
    "INSERT INTO run (id, kind, status, correlation_id, created_at) VALUES ('old', 'expand', 'done', 'fixture', 1)",
  );
  db.exec(
    "INSERT INTO item (id, kind, status, created_at, updated_at) VALUES ('body', 'text', 'included', 1, 1)",
  );
});

afterEach(() => db.close());

it.each([false, true])('清除最後一條機器邊後，人工合併歷史與實體仍在（撤銷：%s）', (undone) => {
  insertEntity(db, { id: 'kept', name: '合成甲', type: 'concept', now: 1 });
  insertEntity(db, { id: 'merged', name: '合成乙', type: 'concept', now: 1 });
  db.exec(
    "INSERT INTO edge (id, source_id, target_id, rel, layer, source_kind, target_kind, origin, status, confidence, run_id, created_at, updated_at) VALUES ('old-edge', 'body', 'merged', '提到', 'comention', 'item', 'entity', 'machine', 'pending', 0.9, 'old', 1, 1)",
  );
  mergeEntities(db, { id: 'merge', keptId: 'kept', mergedId: 'merged', reason: 'manual', now: 2 });
  if (undone) unmergeEntity(db, 'merged', 3);
  const entities = db.prepare('SELECT * FROM entity ORDER BY id').all();
  const history = db.prepare('SELECT * FROM entity_merge').all();
  cleanupExpansion(db);
  expect(db.prepare('SELECT * FROM edge').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM entity ORDER BY id').all()).toEqual(entities);
  expect(db.prepare('SELECT * FROM entity_merge').all()).toEqual(history);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('別名對到同一實體不產生自連，其他關係仍寫入', () => {
  insertEntity(db, { id: 'same', name: '合成甲', type: 'concept', now: 1 });
  addAlias(db, 'same', '合成別名', 2);
  const text = '合成甲支持合成丙';
  const result = applyExtraction(
    db,
    'body',
    'old',
    text,
    normalizeExtraction({
      entities: [
        { name: '合成甲', type: 'concept' },
        { name: '合成別名', type: 'concept' },
        { name: '合成丙', type: 'concept' },
      ],
      relations: [
        { subject: '合成甲', object: '合成別名', rel: '自連', quote: text },
        { subject: '合成甲', object: '合成丙', rel: '支持', quote: text },
      ],
    }),
  );
  expect(result.newEdges).toBe(3);
  expect(db.prepare("SELECT rel FROM edge WHERE layer = 'named'").all()).toEqual([{ rel: '支持' }]);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
});

it('抽取寫入約束失敗會完整回滾，錯誤保留 SQLite 約束分類', () => {
  const extraction = normalizeExtraction({
    entities: [{ name: '合成甲', type: 'concept' }],
    relations: [],
  });
  db.exec(
    "CREATE TRIGGER fail_edge BEFORE INSERT ON edge BEGIN SELECT RAISE(ABORT, 'fixture constraint'); END",
  );
  let failure: unknown;
  try {
    applyExtraction(db, 'body', 'old', '', extraction);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toMatchObject({ code: 'ERR_SQLITE_ERROR' });
  expect(Number((failure as { errcode: number }).errcode) & 0xff).toBe(19);
  expect(db.prepare('SELECT * FROM entity').all()).toEqual([]);
  expect(db.prepare('SELECT * FROM edge').all()).toEqual([]);
});
