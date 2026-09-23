/**
 * schema v10：這個專案**第一次重建資料表**（`run` 與 `item`，Stage 20）。
 *
 * ## 這一份在防的事
 *
 * SQLite 改不了既有的 CHECK，只能「建新表 → 搬資料 → 刪舊表 → 新表換名」。每一步都有一種
 * **安靜的**壞法，而它們全部在一個小的、剛建好的資料庫上看不出來：
 *
 * | 壞法 | 症狀 |
 * |---|---|
 * | 外鍵開著就 `DROP TABLE run` | `run_item` 是 CASCADE —— 每一筆作業的逐項紀錄被刪光，沒有任何錯誤 |
 * | 在交易裡關外鍵 | **no-op**（2026-09-23 實測）—— 上一條照樣發生 |
 * | 重建完少了一個索引 | 查詢照樣對，只是慢；唯一索引少了的話，同一個網址會長出第二個節點 |
 * | `note` 上那條 trigger 沒裝回去 | 點註可以指著一個不是點註的節點 |
 *
 * 所以這一份**對著一個塞了真資料的 v9 資料庫**升級，逐條比對重建前後。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyMigration,
  needsForeignKeysOff,
  openCaseDatabase,
  SUPPORTED_SCHEMA_VERSION,
} from '../../src/infrastructure/db/database.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'src', 'infrastructure', 'db', 'migrations');

let dir = '';
let dbPath = '';

/** 照 runner 的做法把 001–009 跑一遍，停在 v9。 */
async function buildV9(path: string): Promise<DatabaseSync> {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (Number(file.slice(0, 3)) > 9) continue;
    db.exec('BEGIN');
    db.exec(await readFile(join(MIGRATIONS, file), 'utf8'));
    db.exec('COMMIT');
  }
  db.exec('PRAGMA user_version = 9');
  return db;
}

/** 一個像樣的 v9 專題：資料、點註、出處、作業、逐項紀錄、角度、一次研究。 */
function seed(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO "case" VALUES ('self', '舊專題', NULL, 'ready', 1, 1);
    INSERT INTO item (id, kind, title, status, created_at, updated_at, requested_url, sha256, read_at)
      VALUES ('i1', 'web', '網頁', 'included', 1, 1, 'https://a.example/x', 'aa', 5),
             ('i2', 'pdf', '論文', 'failed', 2, 2, 'https://b.example/y', NULL, NULL),
             ('n1', 'note', '點註', 'included', 3, 3, NULL, NULL, NULL);
    INSERT INTO note (id, item_id, body, created_at, updated_at) VALUES ('n1', 'i1', '筆記', 3, 3);
    INSERT INTO entity (id, type, name_zh, created_at, updated_at)
      VALUES ('e1', 'concept', '甲', 1, 1), ('e2', 'concept', '乙', 1, 1);
    INSERT INTO edge (id, layer, rel, source_id, source_kind, target_id, target_kind, origin, status,
                      created_at, updated_at)
      VALUES ('g1', 'named', '關係', 'e1', 'entity', 'e2', 'entity', 'machine', 'pending', 1, 1);
    INSERT INTO edge_evidence VALUES ('ev1', 'g1', 'i1', '一段引文一段引文', 0, 8, 1);
    INSERT INTO run (id, kind, status, correlation_id, created_at, label, total, cost_usd, ended_reason,
                     requests, topic)
      VALUES ('r1', 'import', 'done', 'c1', 1, '匯入', 2, NULL, NULL, 0, NULL),
             ('r2', 'expand', 'cancelled', 'c2', 2, '擴展', 1, 0.18, 'stale', 3, '主題');
    INSERT INTO run_item (id, run_id, requested, item_id, outcome)
      VALUES ('ri1', 'r1', 'https://a.example/x', 'i1', 'ok'),
             ('ri2', 'r1', 'https://b.example/y', 'i2', 'failed');
    INSERT INTO run_angle (id, run_id, ord, question, created_at) VALUES ('a1', 'r2', 0, '問題', 2);
    INSERT INTO research (id, kind, status, topic, correlation_id, created_at, updated_at, collect_run_id)
      VALUES ('rs1', 'research', 'collecting', '主題', 'c3', 5, 5, 'r2');
    INSERT INTO research_direction (id, research_id, ord, title, origin, created_at)
      VALUES ('d1', 'rs1', 0, '方向', 'model', 5);
  `);
}

const TABLES = [
  'item',
  'note',
  'edge_evidence',
  'run',
  'run_item',
  'run_angle',
  'research',
  'research_direction',
] as const;

function counts(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(
    TABLES.map((t) => [
      t,
      Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n),
    ]),
  );
}

/** 一張表的索引與 trigger（名字 ＋ 正規化過空白的 SQL）。 */
function schemaOf(db: DatabaseSync, table: string): string[] {
  return (
    db
      .prepare(
        `SELECT type, name, sql FROM sqlite_master
          WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY name`,
      )
      .all(table) as { type: string; name: string; sql: string }[]
  ).map((r) => `${r.type} ${r.name}: ${r.sql.replace(/\s+/g, ' ')}`);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cyclosa-v10-'));
  dbPath = join(dir, 'case.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('v9 → v10：重建 run 與 item', () => {
  it('每一列都在、每一個索引與 trigger 都在，而且先留了一份備份', async () => {
    const v9 = await buildV9(dbPath);
    seed(v9);
    const before = counts(v9);
    const schema = {
      item: schemaOf(v9, 'item'),
      run: schemaOf(v9, 'run'),
      note: schemaOf(v9, 'note'),
    };
    v9.close();

    const backups = join(dir, 'backups');
    const opened = await openCaseDatabase(dbPath, { backupDir: backups, backupLabel: 'old' });
    expect(opened.kind, JSON.stringify(opened)).toBe('ok');
    if (opened.kind !== 'ok') return;
    const db = opened.db;
    try {
      expect(
        (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(SUPPORTED_SCHEMA_VERSION);
      // **一列都沒少** —— 特別是 `run_item` 與 `run_angle`（外鍵開著的話它們會被 CASCADE 刪光）。
      expect(counts(db)).toEqual(before);
      // 索引與 trigger 一個不少（`run` 只多了研究那一個）。
      expect(schemaOf(db, 'item')).toEqual(schema.item);
      expect(schemaOf(db, 'note')).toEqual(schema.note);
      expect(schemaOf(db, 'run').filter((s) => !s.includes('idx_run_research'))).toEqual(
        schema.run,
      );
      // 欄位的值原樣搬過去。
      expect(
        db.prepare(`SELECT cost_usd, ended_reason, requests, topic FROM run WHERE id = 'r2'`).get(),
      ).toEqual({ cost_usd: 0.18, ended_reason: 'stale', requests: 3, topic: '主題' });
      expect(db.prepare(`SELECT read_at, requested_url FROM item WHERE id = 'i1'`).get()).toEqual({
        read_at: 5,
        requested_url: 'https://a.example/x',
      });
      // 外鍵開回來了。
      expect(
        (db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
      ).toBe(1);
    } finally {
      db.close();
    }
    expect((await readdir(backups)).filter((f) => f.startsWith('old-v9-'))).toHaveLength(1);
  });

  it('重建之後，外鍵、唯一索引、trigger、新的 CHECK 都照樣作用', async () => {
    const v9 = await buildV9(dbPath);
    seed(v9);
    v9.close();
    const opened = await openCaseDatabase(dbPath);
    if (opened.kind !== 'ok') throw new Error(opened.kind);
    const db = opened.db;
    try {
      // 新的值域：書目節點、研究的作業。`paper` 拿掉了。
      db.exec(`INSERT INTO item (id, kind, title, status, created_at, updated_at)
               VALUES ('ref1', 'reference', '書目', 'included', 9, 9)`);
      db.exec(`INSERT INTO run (id, kind, status, correlation_id, created_at, research_id)
               VALUES ('r3', 'research', 'running', 'c', 9, 'rs1')`);
      expect(() =>
        db.exec(`INSERT INTO item (id, kind, title, status, created_at, updated_at)
                 VALUES ('p1', 'paper', 'x', 'included', 9, 9)`),
      ).toThrow(/CHECK/);
      // 唯一索引：同一個網址不長第二個節點。
      expect(() =>
        db.exec(`INSERT INTO item (id, kind, status, created_at, updated_at, requested_url)
                 VALUES ('dup', 'web', 'pending', 1, 1, 'https://a.example/x')`),
      ).toThrow(/UNIQUE/);
      // `note` 上那條 trigger 裝回去了。
      expect(() =>
        db.exec(`INSERT INTO note (id, item_id, created_at, updated_at) VALUES ('i1', 'i1', 1, 1)`),
      ).toThrow(/NOTE_TARGET_MISSING/);
      // 外鍵：刪作業 → 逐項紀錄跟著走；刪資料 → 出處跟著走、點註的指標清掉。
      db.exec(`DELETE FROM run WHERE id = 'r1'`);
      expect((db.prepare('SELECT COUNT(*) AS n FROM run_item').get() as { n: number }).n).toBe(0);
      db.exec(`DELETE FROM item WHERE id = 'i1'`);
      expect((db.prepare('SELECT COUNT(*) AS n FROM edge_evidence').get() as { n: number }).n).toBe(
        0,
      );
      expect(db.prepare(`SELECT item_id FROM note WHERE id = 'n1'`).get()).toEqual({
        item_id: null,
      });
      // 研究被刪掉，它的作業留著、只是不再指著它（ADR-0033 D15）。
      db.exec(`UPDATE research SET status = 'abandoned' WHERE id = 'rs1'`);
      db.exec(`UPDATE research SET collect_run_id = NULL WHERE id = 'rs1'`);
      db.exec(`DELETE FROM research WHERE id = 'rs1'`);
      expect(db.prepare(`SELECT research_id FROM run WHERE id = 'r3'`).get()).toEqual({
        research_id: null,
      });
    } finally {
      db.close();
    }
  });

  it('萬一有一列 `paper`（從來沒建過，但 v1 的 CHECK 允許）：照重算時的對映變成 pdf，不讓整份失敗', async () => {
    const v9 = await buildV9(dbPath);
    seed(v9);
    v9.exec(`INSERT INTO item (id, kind, title, status, created_at, updated_at)
             VALUES ('old-paper', 'paper', '舊的', 'included', 1, 1)`);
    v9.close();
    const opened = await openCaseDatabase(dbPath);
    if (opened.kind !== 'ok') throw new Error(opened.kind);
    try {
      expect(opened.db.prepare(`SELECT kind FROM item WHERE id = 'old-paper'`).get()).toEqual({
        kind: 'pdf',
      });
    } finally {
      opened.db.close();
    }
  });

  it('重建之後多出斷掉的參照：整份退回、版本不動、外鍵開回來', () => {
    // 不是真的 migration 檔 —— 真的那幾份裡不會有一份故意弄斷參照的。
    // 這一份在外鍵關著的時候刪掉一列有人指著的資料（外鍵開著的話那會 CASCADE，關著就是斷掉）。
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(`CREATE TABLE parent (id TEXT PRIMARY KEY);
             CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT REFERENCES parent(id) ON DELETE CASCADE);
             INSERT INTO parent VALUES ('p1'); INSERT INTO child VALUES ('c1', 'p1');
             PRAGMA user_version = 9;`);
    const broken = `-- cyclosa: foreign-keys-off
DELETE FROM parent WHERE id = 'p1';`;

    expect(() => applyMigration(db, broken, 10)).toThrow(/斷掉的外鍵參照/);
    // 退回了：那一列還在、版本停在 9、外鍵開回來了。
    expect(db.prepare('SELECT COUNT(*) AS n FROM parent').get()).toEqual({ n: 1 });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });

    // 同一份不帶標記：外鍵開著，刪 parent 會 CASCADE 刪掉 child —— **那正是重建要避開的事**。
    applyMigration(db, "DELETE FROM parent WHERE id = 'p1';", 10);
    expect(db.prepare('SELECT COUNT(*) AS n FROM child').get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 10 });
    db.close();
  });

  it('v9 那時候就已經斷掉的參照**不會**讓你從此打不開專題', async () => {
    const v9 = await buildV9(dbPath);
    seed(v9);
    // 一列早就斷掉的：外鍵關著的時候留下來的（舊版的某個寫入路徑、手動修過資料庫……）。
    v9.exec('PRAGMA foreign_keys = OFF');
    v9.exec(
      `INSERT INTO run_item (id, run_id, requested, outcome) VALUES ('orphan', 'no-such-run', 'x', 'ok')`,
    );
    v9.close();

    const opened = await openCaseDatabase(dbPath);
    expect(opened.kind, JSON.stringify(opened)).toBe('ok');
    if (opened.kind === 'ok') opened.db.close();
  });
});

describe('執行器的標記', () => {
  it('只認單獨一行的標記', () => {
    expect(needsForeignKeysOff('-- cyclosa: foreign-keys-off\nCREATE TABLE x (a);')).toBe(true);
    expect(needsForeignKeysOff('  -- cyclosa: foreign-keys-off  \r\nSELECT 1;')).toBe(true);
    // 出現在一句註解裡的不算（010 的檔頭就在講這個標記）。
    expect(needsForeignKeysOff('-- 最上面那一行 `-- cyclosa: foreign-keys-off` 讓執行器…')).toBe(
      false,
    );
    expect(needsForeignKeysOff('CREATE TABLE x (a);')).toBe(false);
  });
});
