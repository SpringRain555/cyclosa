import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';

import { applyMigration } from '../../src/infrastructure/db/database.js';
import { defaultFocusId } from '../../src/infrastructure/db/repositories/graph-repo.js';

function database(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const directory = new URL('../../src/infrastructure/db/migrations/', import.meta.url);
  for (const file of readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    applyMigration(db, readFileSync(new URL(file, directory), 'utf8'), Number.parseInt(file, 10));
  }
  return db;
}

function item(db: DatabaseSync, id: string, status = 'included'): void {
  db.prepare(
    'INSERT INTO item (id, kind, title, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, 'text', '合成資料 ' + id, status, 1, 1);
}

function entity(db: DatabaseSync, id: string): void {
  db.prepare(
    'INSERT INTO entity (id, type, name_zh, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run(id, 'concept', '合成實體 ' + id, 1, 1);
}

function edge(
  db: DatabaseSync,
  id: string,
  layer: 'comention' | 'named' | 'similarity' | 'derived',
  source: string,
  sourceKind: 'item' | 'entity',
  target: string,
  targetKind: 'item' | 'entity',
): void {
  db.prepare(
    `INSERT INTO edge (
       id, layer, rel, source_id, source_kind, target_id, target_kind,
       origin, status, confidence, created_at, updated_at
     ) VALUES (?, ?, '合成關係', ?, ?, ?, ?, 'human', 'confirmed', 1, 1, 1)`,
  ).run(id, layer, source, sourceKind, target, targetKind);
}

function mention(db: DatabaseSync, id: string, itemId: string, entityId: string): void {
  edge(db, id, 'comention', itemId, 'item', entityId, 'entity');
}

it('預設焦點選可畫出實體的合成資料，而不是只提到獨有實體最多的資料', () => {
  const db = database();
  try {
    item(db, 'itm-a');
    item(db, 'itm-b');
    for (let i = 0; i < 20; i += 1) {
      const id = 'ent-a-' + String(i).padStart(2, '0');
      entity(db, id);
      mention(db, 'edge-a-' + i, 'itm-a', id);
    }
    for (let i = 0; i < 10; i += 1) {
      const id = 'ent-b-' + String(i).padStart(2, '0');
      entity(db, id);
      mention(db, 'edge-b-' + i, 'itm-b', id);
    }
    entity(db, 'ent-b-named-target');
    for (let i = 0; i < 5; i += 1) {
      edge(
        db,
        'edge-b-named-' + i,
        'named',
        'ent-b-' + String(i).padStart(2, '0'),
        'entity',
        'ent-b-named-target',
        'entity',
      );
    }

    expect(defaultFocusId(db)).toBe('itm-b');
  } finally {
    db.close();
  }
});

it('候選都沒有可畫鄰居時退回度數最高的合成資料', () => {
  const db = database();
  try {
    item(db, 'itm-a');
    item(db, 'itm-b');
    for (let i = 0; i < 8; i += 1) {
      const id = 'ent-a-' + i;
      entity(db, id);
      mention(db, 'edge-a-' + i, 'itm-a', id);
    }
    for (let i = 0; i < 3; i += 1) {
      const id = 'ent-b-' + i;
      entity(db, id);
      mention(db, 'edge-b-' + i, 'itm-b', id);
    }

    expect(defaultFocusId(db)).toBe('itm-a');
  } finally {
    db.close();
  }
});

it('排除的合成資料不會成為焦點', () => {
  const db = database();
  try {
    item(db, 'itm-excluded', 'excluded');
    item(db, 'itm-active');
    for (let i = 0; i < 12; i += 1) {
      const id = 'ent-excluded-' + i;
      entity(db, id);
      mention(db, 'edge-excluded-' + i, 'itm-excluded', id);
    }
    for (let i = 0; i < 2; i += 1) {
      const id = 'ent-active-' + i;
      entity(db, id);
      mention(db, 'edge-active-' + i, 'itm-active', id);
    }

    expect(defaultFocusId(db)).toBe('itm-active');
  } finally {
    db.close();
  }
});

it('同分時依度數再依識別字固定選擇合成資料', () => {
  const db = database();
  try {
    item(db, 'itm-b');
    item(db, 'itm-a');
    edge(db, 'edge-a-b', 'named', 'itm-a', 'item', 'itm-b', 'item');

    expect(defaultFocusId(db)).toBe('itm-a');
  } finally {
    db.close();
  }
});
