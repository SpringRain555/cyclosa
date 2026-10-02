import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { applyMigration } from '../../src/infrastructure/db/database.js';
import { getItem, setItemExtracted } from '../../src/infrastructure/db/repositories/item-repo.js';

it('抽取時間與模型獨立保存，即使沒有建出關聯也能記得抽過；書目原樣讀回', async () => {
  const db = new DatabaseSync(':memory:');
  const migrations = new URL('../../src/infrastructure/db/migrations/', import.meta.url);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
      applyMigration(
        db,
        await readFile(new URL(file, migrations), 'utf8'),
        Number(file.slice(0, 3)),
      );
    }
    db.exec(`INSERT INTO item (id, kind, title, status, created_at, updated_at, bib_json)
      VALUES ('i1', 'reference', '合成書目', 'included', 1, 1, '{"year":"2026"}');`);
    expect(getItem(db, 'i1')).toMatchObject({
      extractedAt: null,
      extractedBy: null,
      bibJson: '{"year":"2026"}',
    });
    setItemExtracted(db, { id: 'i1', extractedBy: 'synthetic:model', now: 7 });
    expect(getItem(db, 'i1')).toMatchObject({
      extractedAt: 7,
      extractedBy: 'synthetic:model',
      updatedAt: 7,
      createdAt: 1,
      bibJson: '{"year":"2026"}',
      title: '合成書目',
      digestedAt: null,
    });
  } finally {
    db.close();
  }
});
