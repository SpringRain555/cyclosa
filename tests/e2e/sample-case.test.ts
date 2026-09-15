/**
 * 端對端：**範例專案**。
 *
 * ## 為什麼是 e2e
 *
 * 範例專案走的是真的匯入管線 —— 寫快照、抽正文、寫索引。
 * 那三件事只有真的跑過才驗得到，而**這一份要驗的正是「它長得像一個真的專題」**：
 * 讀得到正文、搜尋找得到、有待查證的關聯可以裁決。
 *
 * 引文的字元位置**是產生器自己在正文裡找的**，不是寫在語料檔裡（ADR-0021）——
 * 所以這裡也照 v0.8.0 匯出時的做法驗一次：拿區間去切正文，
 * 切出來的必須一字不差等於 `quote`。
 *
 * **完全隔離**：`LOCALAPPDATA` 與資料根都指到臨時目錄。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { initDataRoot } from '../../src/application/bootstrap-service.js';
import { createSampleCase } from '../../src/application/sample-service.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { readDerived } from '../../src/infrastructure/fs/case-files.js';
import { bigramCandidates } from '../../src/infrastructure/index/reader.js';
import { caseDir } from '../../src/infrastructure/fs/paths.js';

let sandbox: string;
let dataRoot: string;
let saved: string | undefined;
let slug: string;
let folder: string;

async function withDb<T>(fn: (db: DatabaseSync) => T): Promise<T> {
  const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(opened.kind);
  try {
    return fn(opened.db);
  } finally {
    opened.db.close();
  }
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-sample-'));
  dataRoot = join(sandbox, 'DataRoot');
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'LocalAppData');
  await mkdir(process.env['LOCALAPPDATA'], { recursive: true });

  const root = await initDataRoot(dataRoot);
  expect(root.ok).toBe(true);
  const made = await createSampleCase(dataRoot);
  expect(made.ok, JSON.stringify(made)).toBe(true);
  if (!made.ok) throw new Error(made.code);
  slug = made.data.slug;
  folder = caseDir(dataRoot, slug);
});

afterEach(async () => {
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

describe('範例專案長得像一個真的專題', () => {
  it('八條條文全部走完管線，一條都沒失敗', async () => {
    const rows = await withDb(
      (db) =>
        db.prepare('SELECT status, count(*) n FROM item GROUP BY status').all() as {
          status: string;
          n: number;
        }[],
    );
    expect(rows).toEqual([{ status: 'included', n: 8 }]);
  });

  it('每一份都指得回它自己那一條的網址 —— 不是整部法規的', async () => {
    const urls = await withDb(
      (db) =>
        db.prepare('SELECT requested_url u FROM item').all() as {
          u: string;
        }[],
    );
    expect(urls).toHaveLength(8);
    for (const { u } of urls) {
      // `flno=` 就是「哪一條」。少了它，出處只指得到整部法規。
      expect(u, u).toMatch(/law\.moj\.gov\.tw\/.*flno=\d+/);
    }
    // 八份指到八個不同的地方。
    expect(new Set(urls.map((r) => r.u)).size).toBe(8);
  });

  it('快照與正文都真的落在磁碟上 —— 閱讀器讀得到', async () => {
    expect((await readdir(join(folder, 'sources'))).length).toBe(8);

    const ids = await withDb((db) => db.prepare('SELECT id FROM item').all() as { id: string }[]);
    for (const { id } of ids) {
      const d = await readDerived(folder, id);
      expect(d, id).not.toBeNull();
      expect(d!.text.length).toBeGreaterThan(20);
    }
  });

  it('有待查證的關聯可以裁決，也有已確認的可以對照', async () => {
    const rows = await withDb(
      (db) =>
        db.prepare('SELECT status, count(*) n FROM edge GROUP BY status').all() as {
          status: string;
          n: number;
        }[],
    );
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    // **兩種都要有。** 全部待查證的話看不到已確認的畫法；
    // 全部已確認的話沒有東西可以裁決 —— 而裁決是這個工具的核心動作。
    expect(by['pending']).toBeGreaterThan(0);
    expect(by['confirmed']).toBeGreaterThan(0);
  });

  it('每一條關聯都在 named 層 —— 只有那一層進裁決佇列', async () => {
    const layers = await withDb(
      (db) => db.prepare('SELECT DISTINCT layer FROM edge').all() as { layer: string }[],
    );
    expect(layers).toEqual([{ layer: 'named' }]);
  });

  /**
   * **這一條是這一份最重要的。**
   *
   * 引文的位置是產生器在正文裡找出來的，不是語料檔給的 ——
   * 所以驗的方式跟 v0.8.0 匯出時一樣：拿區間去切正文，
   * 切出來的必須一字不差。
   *
   * 位置寫死的話會產生一種特別糟的錯：**每一條看起來都完整，
   * 而區間指到別的地方。**
   */
  it('每一段引文都能用區間從正文裡切回來，一字不差', async () => {
    const rows = await withDb(
      (db) =>
        db
          .prepare('SELECT item_id i, quote q, char_start s, char_end e FROM edge_evidence')
          .all() as { i: string; q: string; s: number; e: number }[],
    );
    expect(rows.length).toBeGreaterThan(0);

    for (const r of rows) {
      const d = await readDerived(folder, r.i);
      expect(d, r.i).not.toBeNull();
      expect(d!.text.slice(r.s, r.e), r.q).toBe(r.q);
    }
  });

  it('每一條關聯都有出處 —— 沒有一條是空口說的', async () => {
    const orphans = await withDb(
      (db) =>
        db
          .prepare(
            `SELECT e.id FROM edge e
             LEFT JOIN edge_evidence v ON v.edge_id = e.id
             WHERE v.id IS NULL`,
          )
          .all() as { id: string }[],
    );
    expect(orphans).toEqual([]);
  });

  /**
   * **已確認的邊要有稽核列。**
   *
   * 否則面板上會出現一條「已確認」卻沒有任何人確認過的關聯 ——
   * 而那正是這個工具最不該長出來的東西。
   */
  it('已確認的關聯都有一筆稽核紀錄', async () => {
    const bad = await withDb(
      (db) =>
        db
          .prepare(
            `SELECT e.id FROM edge e
             LEFT JOIN edge_audit a ON a.edge_id = e.id
             WHERE e.status = 'confirmed' AND a.id IS NULL`,
          )
          .all() as { id: string }[],
    );
    expect(bad).toEqual([]);
  });

  it('中文兩個字搜尋得到 —— 索引是匯入時就寫的，不必先重建', async () => {
    // 走真的檢索路徑，不自己拼 SQL —— 表名是實作細節，
    // 而這一條要驗的是「使用者打兩個字找不找得到」。
    const hits = await withDb((db) => bigramCandidates(db, ['公文'], 20));
    expect(hits.length).toBeGreaterThan(0);

    // 「合理」在著作權法 §52／§65 裡都有，所以它應該中不只一份。
    expect((await withDb((db) => bigramCandidates(db, ['合理'], 20))).length).toBeGreaterThan(1);
  });

  it('專題的說明欄說出「這是範例」，而且狀態不是「新建」', async () => {
    const row = await withDb(
      (db) =>
        db.prepare('SELECT name, seed, status FROM "case"').get() as {
          name: string;
          seed: string;
          status: string;
        },
    );
    expect(row.name).toContain('範例');
    expect(row.seed.length).toBeGreaterThan(0);
    // **「新建」的意思是「還沒放東西進去」**，而這個專題裡有 8 份資料。
    // `ingestBytes` 不碰專題狀態（那是 `importFile` 在它外面做的），
    // 所以產生器要自己收這個尾 —— 第一次實跑時它停在 `new`。
    expect(row.status).toBe('ready');
  });

  it('再建一次不會產生第二份', async () => {
    const again = await createSampleCase(dataRoot);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe('CASE_NAME_DUPLICATE');
    expect((await readdir(join(dataRoot, 'cases'))).length).toBe(1);
  });
});
