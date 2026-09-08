/**
 * migration 檔數與 `SUPPORTED_SCHEMA_VERSION` 必須一致。
 *
 * ## 它為什麼存在
 *
 * 2026-09-08 加 `006-entity-identity.sql` 的時候忘了把常數從 5 改成 6
 * （那一行本來跟另一段指令寫在一起，而那段指令整個沒跑起來）。
 *
 * **而症狀不是「新的 migration 沒有跑」** —— migration 迴圈是
 * 「檔名編號 > 目前版本就跑」，所以它照樣跑到了 6。
 * 真正的後果在下一次開檔：`current(6) > SUPPORTED(5)` 命中
 * 「這個資料庫比程式新」那一條，於是**程式拒絕開啟它自己剛剛升級的資料庫**。
 *
 * 一個把使用者鎖在自己資料外面的錯，起因是一行沒改到的常數。
 * 這條測試把它變成紅字。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './helpers.js';
import { SUPPORTED_SCHEMA_VERSION } from '../../src/infrastructure/db/database.js';

const DIR = join(REPO_ROOT, 'src', 'infrastructure', 'db', 'migrations');

const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

describe('schema 版本與 migration 檔', () => {
  it('至少掃到一些檔案（不然這條測試是死的）', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('最後一個 migration 的編號就是 `SUPPORTED_SCHEMA_VERSION`', () => {
    const last = Number((files[files.length - 1] as string).slice(0, 3));
    expect(last).toBe(SUPPORTED_SCHEMA_VERSION);
  });

  it('編號從 001 連號到最後，中間不缺號', () => {
    // 缺號的話 migration 迴圈仍然會跑完，**而版本號會跳** ——
    // 那讓「這個資料庫是哪一版」變成一個要數檔案才知道的問題。
    expect(files.map((f) => Number(f.slice(0, 3)))).toEqual(
      Array.from({ length: files.length }, (_, i) => i + 1),
    );
  });

  it('migration 裡不自己設 `PRAGMA user_version` —— 那是執行器的事', () => {
    // 兩個地方都設的話，它們會在某一次改動之後不一致，
    // 而不一致的那一次不會有任何錯誤訊息。
    const offenders = files.filter((f) =>
      readFileSync(join(DIR, f), 'utf8').includes('user_version'),
    );
    expect(offenders).toEqual([]);
  });
});
