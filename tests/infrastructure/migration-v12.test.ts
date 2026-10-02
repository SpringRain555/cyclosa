import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { applyMigration } from '../../src/infrastructure/db/database.js';

const migrations = new URL('../../src/infrastructure/db/migrations/', import.meta.url);

describe('v11 → v12：只新增確認與建圖的欄位', () => {
  it('合成的舊資料逐欄不動、預設值正確、CHECK 與外鍵都在', async () => {
    const db = new DatabaseSync(':memory:');
    try {
      db.exec('PRAGMA foreign_keys = ON');
      for (const file of (await readdir(migrations))
        .filter((name) => name.endsWith('.sql'))
        .sort()) {
        const version = Number(file.slice(0, 3));
        if (version <= 11)
          applyMigration(db, await readFile(new URL(file, migrations), 'utf8'), version);
      }
      db.exec(`
        INSERT INTO "case" VALUES ('self', '合成專題', NULL, 'ready', 1, 1);
        INSERT INTO item (id, kind, title, status, created_at, updated_at, title_zh, digested_at)
          VALUES ('i1', 'text', 'Synthetic', 'included', 1, 2, '合成資料', 3);
        INSERT INTO run (id, kind, status, correlation_id, created_at)
          VALUES ('run1', 'research', 'done', 'cid', 1);
        INSERT INTO research (id, kind, status, topic, correlation_id, created_at, updated_at, collect_run_id)
          VALUES ('r1', 'research', 'reviewing', '合成主題', 'cid', 1, 2, 'run1');
        INSERT INTO research_direction (id, research_id, ord, title, origin, adopted, created_at)
          VALUES ('d1', 'r1', 0, '合成方向', 'human', 1, 1);
        INSERT INTO research_candidate (id, research_id, direction_id, ord, url, acquisition, expected_access, item_id, relevance, created_at, updated_at)
          VALUES ('c1', 'r1', 'd1', 0, 'https://example.test/synthetic', 'fetched', 'open', 'i1', 'yes', 1, 2);
      `);
      const tables = [
        'case',
        'item',
        'run',
        'research',
        'research_direction',
        'research_candidate',
      ];
      const before = tables.map((table) => db.prepare(`SELECT * FROM "${table}"`).all());
      const schemaBefore = db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') ORDER BY name",
        )
        .all();
      applyMigration(db, await readFile(new URL('012-research-build.sql', migrations), 'utf8'), 12);
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 12 });
      expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      tables.forEach((table, index) => {
        const rows = db.prepare(`SELECT * FROM "${table}"`).all();
        expect(rows).toHaveLength(before[index]!.length);
        rows.forEach((row, rowIndex) => expect(row).toMatchObject(before[index]![rowIndex]!));
      });
      expect(
        db
          .prepare(
            "SELECT name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND tbl_name != 'case_notice' ORDER BY name",
          )
          .all(),
      ).toEqual(schemaBefore);
      expect(db.prepare('SELECT extracted_at, extracted_by, bib_json FROM item').get()).toEqual({
        extracted_at: null,
        extracted_by: null,
        bib_json: null,
      });
      expect(
        db
          .prepare(
            'SELECT decision, cited_by_json, build_state, build_code FROM research_candidate',
          )
          .get(),
      ).toEqual({ decision: null, cited_by_json: '[]', build_state: null, build_code: null });
      expect(db.prepare('SELECT gap_json FROM research').get()).toEqual({ gap_json: null });
      expect(db.prepare('SELECT * FROM case_notice').all()).toEqual([]);
      for (const decision of ['include', 'reference', 'discard', null]) {
        db.prepare('UPDATE research_candidate SET decision = ?').run(decision);
      }
      for (const state of ['done', 'failed', null]) {
        db.prepare('UPDATE research_candidate SET build_state = ?').run(state);
      }
      expect(() => db.exec("UPDATE research_candidate SET decision = 'maybe'")).toThrow(/CHECK/);
      expect(() => db.exec("UPDATE research_candidate SET build_state = 'pending'")).toThrow(
        /CHECK/,
      );
      expect(() => db.exec('UPDATE research_candidate SET cited_by_json = NULL')).toThrow(
        /NOT NULL/,
      );
      expect(() => db.exec("UPDATE research_candidate SET item_id = 'missing'")).toThrow(
        /FOREIGN KEY/,
      );
      db.exec(
        "INSERT INTO case_notice (id, kind, body_json, created_at) VALUES ('n1', 'upgrade', '{}', 4)",
      );
      expect(db.prepare('SELECT dismissed_at FROM case_notice').get()).toEqual({
        dismissed_at: null,
      });
      expect(() =>
        db.exec(
          "INSERT INTO case_notice (id, kind, body_json, created_at) VALUES ('n1', 'upgrade', '{}', 5)",
        ),
      ).toThrow(/UNIQUE/);
      for (const column of ['kind', 'body_json', 'created_at']) {
        expect(() => db.exec(`UPDATE case_notice SET ${column} = NULL`)).toThrow(/NOT NULL/);
      }
    } finally {
      db.close();
    }
  });
});
