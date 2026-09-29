/**
 * schema v11：初讀（Stage 21）。**全部是 `ADD COLUMN`**，所以這一份守的是三件比較小、但一樣安靜的事：
 *
 * | 壞法 | 症狀 |
 * |---|---|
 * | 新欄位的預設值不是「還沒讀」 | 升上來的舊候選看起來像「讀過而且沒關」—— 確認時預設被丟掉 |
 * | `relevance` 沒有 CHECK | 一個打錯的值（`maybe`）寫得進去，畫面把它當成哪一種都不對 |
 * | 原文欄位被動到 | `title` 被繁中蓋掉的話，原文就沒有了（R15：原文永遠不被覆蓋）|
 *
 * 對著一個塞了資料的 v10 資料庫升級（v10 那一份怎麼建的見 `migration-v10.test.ts`）。
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyMigration, openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { getItem, setItemDigest } from '../../src/infrastructure/db/repositories/item-repo.js';
import {
  getCandidate,
  setCandidateDigest,
} from '../../src/infrastructure/db/repositories/research-repo.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'src', 'infrastructure', 'db', 'migrations');

let dir = '';
let dbPath = '';

/** 照執行器的做法（`applyMigration`，含外鍵關著的那一份）把 001–010 跑一遍，停在 v10。 */
async function buildV10(path: string): Promise<DatabaseSync> {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (version > 10) continue;
    applyMigration(db, await readFile(join(MIGRATIONS, file), 'utf8'), version);
  }
  return db;
}

function seed(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO "case" VALUES ('self', '舊專題', NULL, 'ready', 1, 1);
    INSERT INTO item (id, kind, title, status, created_at, updated_at, requested_url, sha256)
      VALUES ('i1', 'web', 'An English Title', 'included', 1, 1, 'https://a.example/x', 'aa');
    INSERT INTO run (id, kind, status, correlation_id, created_at, requests, cost_usd, unpriced)
      VALUES ('r1', 'research', 'done', 'c1', 1, 3, 0.11, 1);
    INSERT INTO research (id, kind, status, topic, correlation_id, created_at, updated_at, collect_run_id)
      VALUES ('rs1', 'research', 'awaiting-user', '主題', 'c2', 5, 5, 'r1');
    INSERT INTO research_candidate (id, research_id, ord, url, title, expected_access, acquisition,
                                    item_id, created_at, updated_at)
      VALUES ('c1', 'rs1', 0, 'https://a.example/x', 'An English Title', 'open', 'fetched', 'i1', 5, 5);
  `);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cyclosa-v11-'));
  dbPath = join(dir, 'case.sqlite');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('v10 → v11：初讀的欄位', () => {
  it('升上來的舊資料是「還沒讀」，原文一個字都沒動', async () => {
    const v10 = await buildV10(dbPath);
    seed(v10);
    v10.close();

    const opened = await openCaseDatabase(dbPath, { backupDir: join(dir, 'backups') });
    if (opened.kind !== 'ok') throw new Error(opened.kind);
    const db = opened.db;
    try {
      expect(
        (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      ).toBe(11);

      const item = getItem(db, 'i1');
      expect(item?.title).toBe('An English Title');
      expect(item?.titleZh).toBeNull();
      expect(item?.summaryZh).toBeNull();
      expect(item?.digestedBy).toBeNull();
      expect(item?.digestedAt).toBeNull();

      // **還沒讀 ＝ relevance 與碼都是 NULL**（讀過但失敗的有碼）—— 不是「讀過而且沒關」。
      const candidate = getCandidate(db, 'c1');
      expect(candidate?.relevance).toBeNull();
      expect(candidate?.relevanceWhy).toBe('');
      expect(candidate?.digestCode).toBeNull();

      // 作業的總數照舊，逐任務那一欄是 NULL（v11 以前的沒有拆）。
      expect(
        db
          .prepare(`SELECT requests, cost_usd, unpriced, task_costs_json FROM run WHERE id = 'r1'`)
          .get(),
      ).toEqual({ requests: 3, cost_usd: 0.11, unpriced: 1, task_costs_json: null });
    } finally {
      db.close();
    }
  });

  it('`relevance` 只收三個值；寫繁中不會蓋掉原文', async () => {
    const v10 = await buildV10(dbPath);
    seed(v10);
    v10.close();
    const opened = await openCaseDatabase(dbPath, { backupDir: join(dir, 'backups') });
    if (opened.kind !== 'ok') throw new Error(opened.kind);
    const db = opened.db;
    try {
      expect(() =>
        db.exec(`UPDATE research_candidate SET relevance = 'maybe' WHERE id = 'c1'`),
      ).toThrow(/CHECK/);

      setItemDigest(db, {
        id: 'i1',
        titleZh: '一個英文標題',
        summaryZh: '兩三句繁中摘要。',
        digestedBy: 'ollama:granite4.2:8b',
        now: 42,
      });
      setCandidateDigest(db, {
        id: 'c1',
        relevance: 'unsure',
        why: '只有目錄',
        code: null,
        now: 42,
      });

      const item = getItem(db, 'i1');
      expect(item?.title).toBe('An English Title');
      expect(item?.titleZh).toBe('一個英文標題');
      expect(item?.digestedBy).toBe('ollama:granite4.2:8b');
      expect(item?.digestedAt).toBe(42);
      expect(getCandidate(db, 'c1')).toMatchObject({
        relevance: 'unsure',
        relevanceWhy: '只有目錄',
        digestCode: null,
      });

      // 讀過但失敗：判斷清掉、碼留著 —— 「繼續蒐集」會再讀一次。
      setCandidateDigest(db, {
        id: 'c1',
        relevance: null,
        why: '',
        code: 'PROVIDER_OUTPUT_UNPARSEABLE',
        now: 43,
      });
      expect(getCandidate(db, 'c1')).toMatchObject({
        relevance: null,
        digestCode: 'PROVIDER_OUTPUT_UNPARSEABLE',
      });
    } finally {
      db.close();
    }
  });
});
