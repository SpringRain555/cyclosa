/** 規則一：人工確認的型別，所有共用抽取寫入都必須保留。 */
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { applyMigration } from '../../src/infrastructure/db/database.js';
import { applyExtraction } from '../../src/application/extraction-service.js';
import { executeRetypeOperation } from '../../src/application/consolidate-ops/retype.js';
import * as entities from '../../src/infrastructure/db/repositories/entity-repo.js';
const migrations = new URL('../../src/infrastructure/db/migrations/', import.meta.url);
it('v15 保留既有實體；人工改型別後模型的不同型別不能另建同名實體或改寫人工值', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort()) {
      const version = Number(file.slice(0, 3));
      if (version <= 14)
        applyMigration(db, await readFile(new URL(file, migrations), 'utf8'), version);
    }
    entities.insertEntity(db, { id: 'e', name: '合成機構', type: 'concept', now: 1 });
    applyMigration(
      db,
      await readFile(new URL('015-entity-type-manual.sql', migrations), 'utf8'),
      15,
    );
    expect(entities.getEntity(db, 'e')).toMatchObject({ type: 'concept', typeManual: false });
    expect(() => db.exec('UPDATE entity SET type_manual = 2')).toThrow();
    db.exec(
      "INSERT INTO item(id,kind,title,status,created_at,updated_at) VALUES ('i','text','合成資料','included',1,1)",
    );
    db.exec(
      "INSERT INTO run(id,kind,status,correlation_id,created_at) VALUES ('r','extract','done','cid',1)",
    );
    expect(executeRetypeOperation({ db, entityId: 'e', to: 'org', completed: () => {} })).toBe(
      true,
    );
    for (const type of ['concept', 'person', 'org'] as const) {
      applyExtraction(db, 'i', 'r', '合成正文', {
        entities: [{ name: '合成機構', type }],
        relations: [],
        dropped: { unknownEntity: 0, selfRelation: 0, duplicate: 0 },
      });
      expect(entities.getEntity(db, 'e')).toMatchObject({ type: 'org', typeManual: true });
      expect(entities.listEntities(db)).toHaveLength(1);
    }
  } finally {
    db.close();
  }
});
it('未經人工改型別的同名異型別實體仍分開，不能將所有型別比對一概拿掉', async () => {
  const rows = [
    {
      id: 'a',
      name: '同名合成',
      type: 'org' as const,
      aliases: [],
      mergedInto: null,
      typeManual: false,
    },
  ];
  expect(entities.findEntityFor(rows, '同名合成', 'person')).toBeNull();
});

it('既有同名異型別實體有明確型別命中時，人工保護不能把它吸進另一個實體', () => {
  const rows = [
    {
      id: 'manual-org',
      name: '同名合成',
      type: 'org' as const,
      aliases: [],
      mergedInto: null,
      typeManual: true,
    },
    {
      id: 'existing-person',
      name: '同名合成',
      type: 'person' as const,
      aliases: [],
      mergedInto: null,
      typeManual: false,
    },
  ];
  expect(entities.findEntityFor(rows, '同名合成', 'person')?.id).toBe('existing-person');
  expect(entities.findEntityFor(rows, '同名合成', 'concept')?.id).toBe('manual-org');
});
