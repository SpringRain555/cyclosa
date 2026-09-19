import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  openCaseDatabase,
  SUPPORTED_SCHEMA_VERSION,
} from '../../src/infrastructure/db/database.js';
import {
  EXTRACTOR_VERSION,
  appendManifest,
  readDerived,
  removeDerived,
  sha256Of,
  writeDerived,
  writeSnapshot,
  clearDerived,
} from '../../src/infrastructure/fs/case-files.js';
import { indexText, reindexTitleRank } from '../../src/infrastructure/index/writer.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION_001 = join(
  HERE,
  '..',
  '..',
  'src',
  'infrastructure',
  'db',
  'migrations',
  '001-initial.sql',
);

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cyclosa-storage-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('快照不可變', () => {
  it('同樣的內容只寫一次，第二次不覆蓋', async () => {
    const bytes = new TextEncoder().encode('<html>原始位元組</html>');
    const first = await writeSnapshot(dir, bytes, 'html');
    expect(first.alreadyExisted).toBe(false);
    expect(first.sha256).toBe(sha256Of(bytes));

    // **第二次寫同一份內容不該動到檔案。** 用 `wx` 而不是「先檢查再寫」——
    // 先檢查再寫中間有一個時間差，而檔案系統不會等我們。
    const again = await writeSnapshot(dir, bytes, 'html');
    expect(again.alreadyExisted).toBe(true);
    expect(again.path).toBe(first.path);

    const onDisk = await readFile(first.path);
    expect(new Uint8Array(onDisk)).toEqual(bytes);
  });

  it('不同內容是不同的檔案', async () => {
    const a = await writeSnapshot(dir, new TextEncoder().encode('a'), 'txt');
    const b = await writeSnapshot(dir, new TextEncoder().encode('b'), 'txt');
    expect(a.path).not.toBe(b.path);
  });
});

describe('衍生物可以整批重算', () => {
  /**
   * **抽取器升版之後、按「重算全部正文」之前，舊版的產物還讀得到。**
   * 沒有這一條的話，升級的下一秒每一份資料都變成「沒有正文」—— 而快照明明還在。
   */
  it('現在這一版沒有就退回讀舊版；兩版都在就讀新的', async () => {
    const base = {
      kind: 'text' as const,
      title: '標題',
      html: null,
      pages: null,
      excerpt: '',
      lowConfidence: false,
      reasons: [] as string[],
    };
    await writeDerived(dir, 'item-2', { ...base, extractorVersion: 1, text: '舊版抽的' });
    expect((await readDerived(dir, 'item-2'))?.text).toBe('舊版抽的');
    expect((await readDerived(dir, 'item-2'))?.extractorVersion).toBe(1);

    await writeDerived(dir, 'item-2', {
      ...base,
      extractorVersion: EXTRACTOR_VERSION,
      text: '新版抽的',
    });
    expect((await readDerived(dir, 'item-2'))?.text).toBe('新版抽的');

    // **刪就每一版都刪。** 只刪現在這一版的話，讀取會退回去讀舊版 ——
    // 「正文不在」變成「讀到一份舊的」，而那一份沒有任何列指向它。
    await removeDerived(dir, 'item-2');
    expect(await readDerived(dir, 'item-2')).toBeNull();
  });

  it('寫得進、讀得回、刪得掉，而且刪它不會動到快照', async () => {
    const snapshot = await writeSnapshot(dir, new TextEncoder().encode('原始'), 'txt');
    await writeDerived(dir, 'item-1', {
      extractorVersion: 1,
      kind: 'text',
      title: '標題',
      text: '正文',
      html: null,
      pages: null,
      excerpt: '正文',
      lowConfidence: false,
      reasons: [],
    });
    expect((await readDerived(dir, 'item-1'))?.title).toBe('標題');

    await clearDerived(dir);
    expect(await readDerived(dir, 'item-1')).toBeNull();

    // **快照還在** —— 這就是「點註錨在快照上，重算不會讓它漂掉」的物理基礎
    await expect(readFile(snapshot.path)).resolves.toBeDefined();
  });
});

describe('manifest.jsonl', () => {
  it('每行一個 JSON', async () => {
    for (const id of ['a', 'b']) {
      await appendManifest(dir, {
        at: new Date().toISOString(),
        url: `https://example.com/${id}`,
        itemId: id,
        status: 'ok',
        code: null,
        sha256: null,
        byteSize: 1,
        contentType: 'text/html',
        hops: [],
      });
    }
    const lines = (await readFile(join(dir, 'manifest.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(() => lines.map((l) => JSON.parse(l))).not.toThrow();
  });
});

describe('schema migration', () => {
  it('v1 的資料庫升到 v2，**而且升之前先留一份複本**', async () => {
    const dbPath = join(dir, 'case.sqlite');
    const v1 = new DatabaseSync(dbPath);
    v1.exec(await readFile(MIGRATION_001, 'utf8'));
    v1.exec('PRAGMA user_version = 1');
    v1.prepare(
      `INSERT INTO "case" (id, name, seed, status, created_at, updated_at)
       VALUES ('self', '舊專題', NULL, 'ready', 1, 1)`,
    ).run();
    v1.close();

    const backupDir = join(dir, 'backups');
    const opened = await openCaseDatabase(dbPath, { backupDir, backupLabel: 'old-case' });
    expect(opened.kind).toBe('ok');
    if (opened.kind !== 'ok') return;

    try {
      const version = opened.db.prepare('PRAGMA user_version').get() as { user_version?: number };
      expect(version.user_version).toBe(SUPPORTED_SCHEMA_VERSION);

      // v2 的欄位在
      const cols = opened.db.prepare('PRAGMA table_info(item)').all() as { name?: unknown }[];
      const names = cols.map((c) => String(c['name']));
      expect(names).toContain('requested_url');
      expect(names).toContain('low_confidence_reasons');
      expect(names).toContain('error_code');

      // 舊資料還在
      const row = opened.db.prepare('SELECT name FROM "case" WHERE id = \'self\'').get() as {
        name?: unknown;
      };
      expect(String(row?.name)).toBe('舊專題');
    } finally {
      opened.db.close();
    }

    const backups = await readdir(backupDir);
    expect(backups.filter((f) => f.startsWith('old-case-v1-'))).toHaveLength(1);
  });

  it('全新的資料庫不需要備份（沒有東西可以失去）', async () => {
    const opened = await openCaseDatabase(join(dir, 'fresh.sqlite'), {
      backupDir: join(dir, 'backups'),
      backupLabel: 'fresh',
      create: true,
    });
    expect(opened.kind).toBe('ok');
    if (opened.kind === 'ok') opened.db.close();
    await expect(readdir(join(dir, 'backups'))).rejects.toThrow();
  });

  it('備份寫不進去就不 migrate —— **沒有退路的 migration 不做**', async () => {
    const dbPath = join(dir, 'case.sqlite');
    const v1 = new DatabaseSync(dbPath);
    v1.exec(await readFile(MIGRATION_001, 'utf8'));
    v1.exec('PRAGMA user_version = 1');
    v1.close();

    // 用一個「同名的檔案」擋住備份目錄的建立
    const blocked = join(dir, 'blocked-backups');
    await writeFile(blocked, 'not a directory', 'utf8');

    const opened = await openCaseDatabase(dbPath, { backupDir: blocked, backupLabel: 'x' });
    expect(opened.kind).toBe('migrate-failed');

    const after = new DatabaseSync(dbPath);
    const version = after.prepare('PRAGMA user_version').get() as { user_version?: number };
    expect(version.user_version).toBe(1);
    after.close();
  });
});

describe('索引寫入', () => {
  async function freshDb(): Promise<DatabaseSync> {
    const opened = await openCaseDatabase(join(dir, 'idx.sqlite'), { create: true });
    if (opened.kind !== 'ok') throw new Error('開不起來');
    opened.db
      .prepare(
        `INSERT INTO item (id, kind, title, status, created_at, updated_at)
         VALUES ('i1', 'web', '台積電的關聯', 'included', 1, 1)`,
      )
      .run();
    return opened.db;
  }

  it('中文走 bigram、英文走 FTS5、und 兩條都走', async () => {
    const db = await freshDb();
    try {
      const zh = indexText(db, {
        ownerKind: 'item',
        ownerId: 'i1',
        lang: 'cmn',
        title: '台積電',
        text: '疫情',
      });
      expect(zh.bigramRows).toBeGreaterThan(0);
      expect(zh.ftsRows).toBe(0);

      const en = indexText(db, {
        ownerKind: 'item',
        ownerId: 'i1',
        lang: 'eng',
        title: 'Hello',
        text: 'world',
      });
      expect(en.bigramRows).toBe(0);
      expect(en.ftsRows).toBe(1);

      const und = indexText(db, {
        ownerKind: 'item',
        ownerId: 'i1',
        lang: 'und',
        title: '混合 mixed',
        text: '內容',
      });
      expect(und.bigramRows).toBeGreaterThan(0);
      expect(und.ftsRows).toBe(1);
    } finally {
      db.close();
    }
  });

  it('**先刪再寫** —— 重抽之後查不到已經不存在的文字', async () => {
    const db = await freshDb();
    try {
      indexText(db, { ownerKind: 'item', ownerId: 'i1', lang: 'cmn', title: '', text: '疫情擴散' });
      const before = db.prepare("SELECT COUNT(*) AS n FROM bigram WHERE gram = '疫情'").get() as {
        n?: unknown;
      };
      expect(Number(before?.n)).toBe(1);

      indexText(db, { ownerKind: 'item', ownerId: 'i1', lang: 'cmn', title: '', text: '完全不同' });
      const after = db.prepare("SELECT COUNT(*) AS n FROM bigram WHERE gram = '疫情'").get() as {
        n?: unknown;
      };
      expect(Number(after?.n)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('標題名次整批重排', async () => {
    const db = await freshDb();
    try {
      db.prepare(
        `INSERT INTO item (id, kind, title, status, created_at, updated_at)
         VALUES ('i2', 'web', '一開始', 'included', 1, 1)`,
      ).run();
      expect(reindexTitleRank(db)).toBe(2);
      const ranks = db.prepare('SELECT id, title_rank FROM item ORDER BY title_rank').all() as {
        id?: unknown;
      }[];
      expect(ranks.map((r) => String(r['id']))).toEqual(['i2', 'i1']);
    } finally {
      db.close();
    }
  });
});
