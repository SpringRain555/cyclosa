import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { applyMigration } from '../../src/infrastructure/db/database.js';
import { FIXTURE, writeSyntheticGraph } from '../../tools/dev/graph-fixture.js';

it('合成書目沒有正文或快照，帶原網址且連到一份資料', () => {
  const db = new DatabaseSync(':memory:');
  try {
    const directory = new URL('../../src/infrastructure/db/migrations/', import.meta.url);
    for (const file of readdirSync(directory)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      applyMigration(db, readFileSync(new URL(file, directory), 'utf8'), Number.parseInt(file, 10));
    }
    writeSyntheticGraph(db);
    expect(
      db
        .prepare("SELECT kind, excerpt, sha256, source_url FROM item WHERE id = 'itm-reference'")
        .get(),
    ).toMatchObject({
      kind: 'reference',
      excerpt: '',
      sha256: null,
      source_url: 'https://example.invalid/reference',
    });
    expect(
      db
        .prepare("SELECT source_id, target_id, origin, status FROM edge WHERE id = 'edg-reference'")
        .get(),
    ).toMatchObject({
      source_id: FIXTURE.focus,
      target_id: 'itm-reference',
      // 人建、已確認 —— 不進裁決佇列
      origin: 'human',
      status: 'confirmed',
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
  }
});
