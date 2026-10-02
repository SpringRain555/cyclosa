import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigration, openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { cleanupExpansion } from '../../src/infrastructure/db/cleanup-expansion.js';
import { indexText } from '../../src/infrastructure/index/writer.js';
import { derivedPath, EXTRACTOR_VERSION } from '../../src/infrastructure/fs/case-files.js';

const migrations = new URL('../../src/infrastructure/db/migrations/', import.meta.url);
let folder = '';
let path = '';
let backupDir = '';

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), 'cyclosa-v13-'));
  path = join(folder, 'case.sqlite');
  backupDir = join(folder, 'backups');
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

async function buildV12(): Promise<DatabaseSync> {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort()) {
    const version = Number(file.slice(0, 3));
    if (version <= 12)
      applyMigration(db, await readFile(new URL(file, migrations), 'utf8'), version);
  }
  return db;
}

function seed(db: DatabaseSync): void {
  for (const [id, kind, providers] of [
    ['old-a', 'expand', null],
    ['old-b', 'expand', '{}'],
    ['manual-chat', 'expand', '{"chat":"manual:fixture"}'],
    ['manual-json', 'expand', '{"json":{"extract":"manual"}}'],
    ['import', 'import', null],
    ['research', 'research', null],
    ['consolidate', 'consolidate', null],
  ]) {
    db.prepare(
      `INSERT INTO run (id, kind, status, correlation_id, created_at, providers_json,
      task_costs_json, cost_usd, requests, unpriced) VALUES (?, ?, 'done', 'cid', 1, ?, '{}', 0.3, 2, 1)`,
    ).run(id!, kind!, providers ?? null);
    db.prepare(
      "INSERT INTO run_item (id, run_id, requested, outcome) VALUES (?, ?, 'synthetic', 'ok')",
    ).run(`entry-${id}`, id!);
  }
  db.exec(`INSERT INTO "case" VALUES ('self', '合成專題', NULL, 'ready', 1, 1);
    INSERT INTO research (id, kind, status, topic, correlation_id, created_at, updated_at, collect_run_id)
      VALUES ('study', 'research', 'done', '合成', 'cid', 1, 1, 'research');
    UPDATE run SET research_id = 'study' WHERE id = 'research';
    UPDATE research SET build_run_id = 'old-b' WHERE id = 'study';
    INSERT INTO run_angle (id, run_id, ord, question, created_at) VALUES ('angle', 'old-a', 0, '合成', 1);`);
  for (const id of [
    'delete',
    'batch-only',
    'read',
    'annotated',
    'excluded',
    'judged-evidence',
    'judged-endpoint',
    'cross-evidence',
    'cross-source',
    'cross-target',
    'human',
    'manual-item',
  ]) {
    db.prepare(
      `INSERT INTO item (id, kind, status, run_id, read_at, created_at, updated_at)
      VALUES (?, 'text', ?, ?, ?, 1, 1)`,
    ).run(
      id,
      id === 'excluded' ? 'excluded' : 'included',
      id === 'manual-item' ? 'manual-chat' : 'old-a',
      id === 'read' ? 2 : null,
    );
    indexText(db, {
      ownerKind: 'item',
      ownerId: id,
      lang: 'zh',
      title: '合成 title',
      text: '合成 body',
    });
    db.prepare("INSERT INTO vector VALUES (?, 'item', ?, 'fixture', 1, X'00000000', 1)").run(
      `v-${id}`,
      id,
    );
  }
  db.exec(`INSERT INTO item (id, kind, status, created_at, updated_at) VALUES ('note', 'note', 'included', 1, 1);
    INSERT INTO note (id, item_id, body, created_at, updated_at) VALUES ('note', 'annotated', '合成', 1, 1);`);
  for (const [id, runId, origin, sourceId, targetId, evidence] of [
    ['delete-edge', 'old-a', 'machine', 'delete', 'manual-item', 'delete'],
    ['batch-edge', 'old-b', 'machine', 'batch-only', 'manual-item', 'batch-only'],
    ['judged', 'old-a', 'machine', 'judged-endpoint', 'manual-item', 'judged-evidence'],
    ['human-edge', 'old-a', 'human', 'human', 'manual-item', 'human'],
    ['cross', 'manual-chat', 'machine', 'cross-source', 'cross-target', 'cross-evidence'],
  ]) {
    db.prepare(
      `INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind,
      origin, status, run_id, created_at, updated_at) VALUES (?, 'named', ?, ?, 'item', ?, 'item', ?, 'pending', ?, 1, 1)`,
    ).run(id!, id!, sourceId!, targetId!, origin!, runId!);
    db.prepare("INSERT INTO edge_evidence VALUES (?, ?, ?, '合成', 0, 2, 1)").run(
      `evidence-${id}`,
      id!,
      evidence!,
    );
  }
  db.exec(`UPDATE edge SET status = 'rejected' WHERE id = 'judged';
    INSERT INTO edge_audit VALUES ('audit', 'judged', 'pending', 'rejected', 'reject', 'human', 'old-a', 2);`);
}

function ids(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`SELECT id FROM "${table}" ORDER BY id`)
    .all()
    .map((row) => String(row['id']));
}

describe('v13 清除舊擴展', () => {
  it('同一頁同時開啟專題時只升級一次、不重寫通知', async () => {
    const previous = await buildV12();
    seed(previous);
    previous.close();
    const results = await Promise.all([
      openCaseDatabase(path, { backupDir, backupLabel: 'same-case' }),
      openCaseDatabase(path, { backupDir, backupLabel: 'same-case' }),
    ]);
    try {
      expect(results.map((result) => result.kind)).toEqual(['ok', 'ok']);
      for (const result of results) {
        if (result.kind !== 'ok') continue;
        expect(ids(result.db, 'case_notice')).toHaveLength(1);
        expect(result.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      }
    } finally {
      for (const result of results) if (result.kind === 'ok') result.db.close();
    }
  });

  it('混合專題：保護人工判定與跨作業參照、備份、清衍生物，第二次完全不變', async () => {
    const previous = await buildV12();
    seed(previous);
    const manualBefore = previous.prepare("SELECT * FROM run WHERE id = 'manual-chat'").get();
    const researchBefore = previous.prepare("SELECT * FROM run WHERE id = 'research'").get();
    previous.close();
    await mkdir(join(folder, 'derived'));
    await mkdir(join(folder, 'sources'));
    await writeFile(join(folder, 'sources', 'snapshot.txt'), 'immutable');
    for (const id of ['delete', 'batch-only', 'read']) {
      for (let version = 1; version <= EXTRACTOR_VERSION; version++) {
        await writeFile(derivedPath(folder, id, version), '{}');
      }
    }
    const opened = await openCaseDatabase(path, { backupDir });
    expect(opened.kind, JSON.stringify(opened)).toBe('ok');
    if (opened.kind !== 'ok') return;
    const db = opened.db;
    let notice: unknown;
    try {
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 });
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(ids(db, 'run')).toEqual([
        'consolidate',
        'import',
        'manual-chat',
        'manual-json',
        'research',
      ]);
      expect(db.prepare("SELECT * FROM run WHERE id = 'manual-chat'").get()).toEqual({
        ...manualBefore,
        kind: 'extract',
      });
      expect(db.prepare("SELECT kind FROM run WHERE id = 'manual-json'").get()).toEqual({
        kind: 'extract',
      });
      expect(db.prepare("SELECT * FROM run WHERE id = 'research'").get()).toEqual(researchBefore);
      expect(ids(db, 'run_item')).toHaveLength(5);
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name = 'run_angle'").get(),
      ).toBeUndefined();
      expect(ids(db, 'item')).toEqual([
        'annotated',
        'cross-evidence',
        'cross-source',
        'cross-target',
        'excluded',
        'human',
        'judged-endpoint',
        'judged-evidence',
        'manual-item',
        'note',
        'read',
      ]);
      expect(ids(db, 'edge')).toEqual(['cross', 'human-edge', 'judged']);
      expect(ids(db, 'edge_evidence')).toEqual([
        'evidence-cross',
        'evidence-human-edge',
        'evidence-judged',
      ]);
      expect(db.prepare("SELECT status, run_id FROM edge WHERE id = 'judged'").get()).toEqual({
        status: 'rejected',
        run_id: null,
      });
      expect(ids(db, 'edge_audit')).toEqual(['audit']);
      expect(db.prepare("SELECT run_id FROM edge_audit WHERE id = 'audit'").get()).toEqual({
        run_id: 'old-a',
      });
      expect(
        db.prepare("SELECT collect_run_id, build_run_id FROM research WHERE id = 'study'").get(),
      ).toEqual({ collect_run_id: 'research', build_run_id: null });
      for (const table of ['bigram', 'fts_text', 'vector']) {
        expect(
          db.prepare(`SELECT * FROM ${table} WHERE owner_id IN ('delete', 'batch-only')`).all(),
        ).toEqual([]);
        expect(
          db.prepare(`SELECT * FROM ${table} WHERE owner_id = 'read'`).all().length,
        ).toBeGreaterThan(0);
      }
      notice = db.prepare('SELECT * FROM case_notice').all();
      const body = JSON.parse(
        String(db.prepare('SELECT body_json FROM case_notice').get()!['body_json']),
      ) as unknown;
      expect(body).toEqual({
        deletedRuns: 2,
        deletedItems: 2,
        deletedEdges: 2,
        keptItems: 9,
        keptEdges: 2,
        reasons: { read: 1, annotated: 1, excluded: 1, referenced: 6, otherRuns: 3 },
      });
      expect(cleanupExpansion(db)).toEqual([]);
      expect(db.prepare('SELECT * FROM case_notice').all()).toEqual(notice);
      expect(() => db.exec("UPDATE run SET kind = 'expand' WHERE id = 'import'")).toThrow(/CHECK/);
      for (const kind of ['import', 'extract', 'research', 'consolidate']) {
        db.prepare("UPDATE run SET kind = ? WHERE id = 'import'").run(kind);
      }
      db.exec("UPDATE run SET kind = 'import' WHERE id = 'import'");
    } finally {
      db.close();
    }
    const derived = await readdir(join(folder, 'derived'));
    expect(derived).toHaveLength(EXTRACTOR_VERSION);
    expect(derived.every((name) => name.includes('read'))).toBe(true);
    expect(await readFile(join(folder, 'sources', 'snapshot.txt'), 'utf8')).toBe('immutable');
    const backups = await readdir(backupDir);
    expect(backups).toHaveLength(1);
    const backup = new DatabaseSync(join(backupDir, backups[0]!));
    try {
      expect(backup.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 });
      expect(ids(backup, 'run')).toHaveLength(7);
    } finally {
      backup.close();
    }
    const again = await openCaseDatabase(path, { backupDir });
    expect(again.kind).toBe('ok');
    if (again.kind === 'ok') {
      expect(again.db.prepare('SELECT * FROM case_notice').all()).toEqual(notice);
      expect(again.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      again.db.close();
    }
    expect(await readdir(backupDir)).toEqual(backups);
  });

  it('清理用自己的交易，失敗時連通知、索引與向量一起退回', async () => {
    const db = await buildV12();
    try {
      seed(db);
      db.exec(
        "CREATE TRIGGER fail_notice BEFORE INSERT ON case_notice BEGIN SELECT RAISE(ABORT, 'fixture failure'); END",
      );
      expect(() => cleanupExpansion(db)).toThrow(/fixture failure/);
      expect(ids(db, 'run')).toHaveLength(7);
      expect(ids(db, 'item')).toContain('delete');
      expect(ids(db, 'edge')).toContain('delete-edge');
      expect(ids(db, 'case_notice')).toEqual([]);
      for (const table of ['bigram', 'fts_text', 'vector']) {
        expect(
          db.prepare(`SELECT * FROM ${table} WHERE owner_id = 'delete'`).all().length,
        ).toBeGreaterThan(0);
      }
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      db.exec('DROP TRIGGER fail_notice');
      expect([...cleanupExpansion(db)].sort()).toEqual(['batch-only', 'delete']);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 });
      const notice = db.prepare('SELECT * FROM case_notice').all();
      expect(cleanupExpansion(db)).toEqual([]);
      expect(db.prepare('SELECT * FROM case_notice').all()).toEqual(notice);
    } finally {
      db.close();
    }
  });

  it.each([null, '{', 'null', '[]', '{"chat":"not-manual:x"}', '{"json":{"extract":"schema"}}'])(
    '非手動標記 %s 不會被誤保留',
    async (providers) => {
      const db = await buildV12();
      try {
        db.prepare(
          "INSERT INTO run (id, kind, status, correlation_id, created_at, providers_json) VALUES ('old', 'expand', 'done', 'cid', 1, ?)",
        ).run(providers);
        cleanupExpansion(db);
        expect(ids(db, 'run')).toEqual([]);
        expect(ids(db, 'case_notice')).toHaveLength(1);
      } finally {
        db.close();
      }
    },
  );

  it('沒有舊擴展不產生通知；空白新專題也能升到 v13', async () => {
    const opened = await openCaseDatabase(path, { create: true });
    expect(opened.kind).toBe('ok');
    if (opened.kind === 'ok') {
      expect(ids(opened.db, 'case_notice')).toEqual([]);
      expect(opened.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 13 });
      opened.db.close();
    }
  });

  it('既有專題沒給備份目錄或備份失敗時，完全不清', async () => {
    const db = await buildV12();
    seed(db);
    db.close();
    expect(await openCaseDatabase(path)).toMatchObject({ kind: 'migrate-failed', at: 'backup' });
    await writeFile(backupDir, 'not a directory');
    expect(await openCaseDatabase(path, { backupDir })).toMatchObject({
      kind: 'migrate-failed',
      at: 'backup',
    });
    const unchanged = new DatabaseSync(path);
    try {
      expect(ids(unchanged, 'run')).toHaveLength(7);
      expect(ids(unchanged, 'case_notice')).toEqual([]);
      expect(unchanged.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 });
    } finally {
      unchanged.close();
    }
  });
});
