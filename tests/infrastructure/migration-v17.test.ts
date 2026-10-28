/**
 * v16：`case.derived_version`；v17：v1.0.1 之前開的研究，命中的「專題裡已有的」補上網址（ADR-0039 第五節）。
 */
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';

import { applyMigration } from '../../src/infrastructure/db/database.js';

const migrations = new URL('../../src/infrastructure/db/migrations/', import.meta.url);

async function upTo(db: DatabaseSync, last: number, after = 0): Promise<void> {
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
    const version = Number(file.slice(0, 3));
    if (version > after && version <= last)
      applyMigration(db, await readFile(new URL(file, migrations), 'utf8'), version);
  }
}

it('v16：既有專題的 derived_version 從 0 起算（還沒升級過），不准負數', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    await upTo(db, 15);
    db.prepare(
      `INSERT INTO "case" (id, name, status, created_at, updated_at) VALUES ('self', '既有', 'ready', 1, 1)`,
    ).run();
    await upTo(db, 16, 15);
    expect(db.prepare('SELECT derived_version v FROM "case"').get()).toEqual({ v: 0 });
    expect(() => db.prepare('UPDATE "case" SET derived_version = -1').run()).toThrow();
  } finally {
    db.close();
  }
});

it('v17：舊研究的命中補上網址（來源網址優先、其次要求的網址、資料不在了是空字串），順序與其他欄位不動', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  try {
    await upTo(db, 16);
    const item = db.prepare(
      `INSERT INTO item (id, kind, title, title_rank, requested_url, source_url, lang, status, created_at, updated_at)
       VALUES (?, 'web', ?, ?, ?, ?, 'zh', 'included', 1, 1)`,
    );
    item.run('a', '甲', '甲', 'https://req.example/a', 'https://src.example/a');
    item.run('b', '乙', '乙', 'https://req.example/b', null);
    const old = [
      { itemId: 'b', title: '乙', excerpt: '二' },
      { itemId: 'a', title: '甲', excerpt: '一' },
      { itemId: 'gone', title: '刪掉了', excerpt: '三' },
    ];
    const research = db.prepare(
      `INSERT INTO research (id, kind, status, correlation_id, created_at, updated_at, hits_json)
       VALUES (?, 'research', 'done', 'cid', 1, 1, ?)`,
    );
    research.run('old', JSON.stringify(old));
    // v1.0.1 之後開的（已經有 url）與形狀不對的：不動。
    const fresh = JSON.stringify([
      { itemId: 'a', title: '甲', excerpt: '一', url: 'https://kept.example' },
    ]);
    research.run('fresh', fresh);
    research.run('odd', '["not-an-object"]');

    await upTo(db, 17, 16);
    const hits = (id: string): unknown =>
      JSON.parse(
        String(
          (db.prepare('SELECT hits_json h FROM research WHERE id = ?').get(id) as { h: string }).h,
        ),
      );
    expect(hits('old')).toEqual([
      { itemId: 'b', title: '乙', excerpt: '二', url: 'https://req.example/b' },
      { itemId: 'a', title: '甲', excerpt: '一', url: 'https://src.example/a' },
      { itemId: 'gone', title: '刪掉了', excerpt: '三', url: '' },
    ]);
    expect(hits('fresh')).toEqual(JSON.parse(fresh));
    expect(hits('odd')).toEqual(['not-an-object']);
  } finally {
    db.close();
  }
});
