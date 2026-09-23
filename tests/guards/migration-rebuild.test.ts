/**
 * 守門：**會 `DROP TABLE` 的 migration 一定要帶「外鍵關著跑」的標記**（`FOREIGN_KEYS_OFF_MARKER`）。
 *
 * ## 為什麼需要這一條
 *
 * 重建資料表（SQLite 改 CHECK 的唯一辦法）要刪掉舊表。**外鍵開著的時候，`DROP TABLE` 會先做一次
 * 隱含的 `DELETE`**，而指著它的表如果是 `ON DELETE CASCADE`（`run_item`、`run_angle` 指著 `run`，
 * `edge_evidence` 指著 `item`）—— 那些列會被一起刪光，**沒有任何錯誤訊息**。
 *
 * 而在 migration 檔裡自己寫 `PRAGMA foreign_keys = OFF` 沒有用：執行器把整份包在一個交易裡，
 * **交易裡的 `PRAGMA foreign_keys` 是 no-op**（2026-09-23 實測）。所以唯一的做法是標記，
 * 讓執行器在交易外面關（`database.ts`）。
 *
 * 漏了標記的那一份在一個剛建好的資料庫上跑得完全正常（沒有子表的列可以刪），
 * 只在使用者真的有資料的時候才把資料刪掉 —— 那正是測試抓不到、所以要守門的那一種。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { needsForeignKeysOff } from '../../src/infrastructure/db/database.js';
import { REPO_ROOT } from './helpers.js';

const DIR = join(REPO_ROOT, 'src', 'infrastructure', 'db', 'migrations');

/** 把註解拿掉再找 —— 010 的檔頭就在**講** `DROP TABLE`，那不是一句 SQL。 */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

function dropsTable(sql: string): boolean {
  return /\bDROP\s+TABLE\b/i.test(stripComments(sql));
}

function offenders(files: readonly { name: string; sql: string }[]): string[] {
  return files.filter((f) => dropsTable(f.sql) && !needsForeignKeysOff(f.sql)).map((f) => f.name);
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((name) => ({ name, sql: readFileSync(join(DIR, name), 'utf8') }));

describe('重建資料表的 migration 帶著關外鍵的標記', () => {
  it('至少掃到一份會 DROP TABLE 的（不然這條測試是死的）', () => {
    expect(files.filter((f) => dropsTable(f.sql)).map((f) => f.name)).toContain(
      '010-research-collect.sql',
    );
  });

  it('每一份會 DROP TABLE 的都帶著標記', () => {
    expect(offenders(files)).toEqual([]);
  });

  it('判準認得出漏了標記的那一份 —— 注入一次', () => {
    const v10 = files.find((f) => f.name === '010-research-collect.sql');
    if (v10 === undefined) throw new Error('找不到 010');
    const unmarked = v10.sql
      .split('\n')
      .filter((line) => line.trim() !== '-- cyclosa: foreign-keys-off')
      .join('\n');
    expect(offenders([{ name: '010（拿掉標記）', sql: unmarked }])).toEqual(['010（拿掉標記）']);
    // 註解裡寫到 DROP TABLE 不算。
    expect(dropsTable('-- 這裡在講 DROP TABLE run\nSELECT 1;')).toBe(false);
  });
});
