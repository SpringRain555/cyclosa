import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { applyMigration } from '../../src/infrastructure/db/database.js';

const migrations = new URL('../../src/infrastructure/db/migrations/', import.meta.url);

it('v14 建立 consolidate_op，並套用兩個外鍵刪除規則與值域約束', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
      const version = Number(file.slice(0, 3));
      if (version <= 13)
        applyMigration(db, await readFile(new URL(file, migrations), 'utf8'), version);
    }

    expect(
      Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
    ).toBe(13);
    const sql = await readFile(new URL('014-consolidate-ops.sql', migrations), 'utf8');
    applyMigration(db, sql, 14);
    expect(
      Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version),
    ).toBe(14);

    db.prepare(
      `INSERT INTO research (id, kind, status, correlation_id, created_at, updated_at)
       VALUES ('shell', 'consolidate', 'reviewing', 'cid', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO run (id, kind, status, correlation_id, created_at)
       VALUES ('run', 'consolidate', 'done', 'cid', 1)`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO consolidate_op (id, research_id, ord, kind, payload_json, why, run_id)
       VALUES (?, 'shell', ?, ?, '{}', '合成理由', ?)`,
    );
    insert.run('op-extract', 0, 'extract', 'run');
    insert.run('op-retype', 1, 'retype', null);

    expect(() => insert.run('op-bad-kind', 2, 'unknown', null)).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO consolidate_op (id, research_id, ord, kind, payload_json, why, state)
         VALUES ('op-bad-state', 'shell', 2, 'digest', '{}', '合成理由', 'unknown')`,
        )
        .run(),
    ).toThrow();

    db.prepare("DELETE FROM run WHERE id = 'run'").run();
    expect(db.prepare("SELECT run_id FROM consolidate_op WHERE id = 'op-extract'").get()).toEqual({
      run_id: null,
    });
    db.prepare("DELETE FROM research WHERE id = 'shell'").run();
    expect(
      Number((db.prepare('SELECT COUNT(*) AS n FROM consolidate_op').get() as { n: number }).n),
    ).toBe(0);
  } finally {
    db.close();
  }
});
