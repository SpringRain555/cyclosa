/**
 * 端對端：全文檢索。
 *
 * **這一份要證明的第一件事是那個實測反例**：中文兩個字查得到。
 * FTS5 的 `trigram` 對兩個字的中文查詢命中 0 列（2026-09-05 實測），
 * 而中文查詢多半是兩個字 —— 整條 bigram 路線就是為了這一行測試存在的。
 *
 * **第二件事比較不明顯：索引會誤中，而正文會拆穿它。**
 * 查「台積電」切出「台積」與「積電」兩個 gram，
 * 而一份寫著「來台積極…累積電力」的文件**兩個 gram 都有** ——
 * 索引層沒有位置，分不出來。所以候選拿到之後要回去讀正文。
 *
 * 這跟 v0.8.0 匯出時重新驗引文是同一個判斷，第四次出現。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import { indexText, reindexTitleRank } from '../../src/infrastructure/index/writer.js';
import {
  EXTRACTOR_VERSION,
  removeDerived,
  writeDerived,
} from '../../src/infrastructure/fs/case-files.js';
import { setExcerpt } from '../../src/infrastructure/db/repositories/item-repo.js';
import { insertRun } from '../../src/infrastructure/db/repositories/run-repo.js';

let sandbox = '';
let dataRoot = '';
let slug = '';
let caseFolder = '';
let app: FastifyInstance;
let savedLocalAppData: string | undefined;

interface Envelope<T> {
  ok: boolean;
  code?: string;
  data?: T;
}

interface Hit {
  kind: 'item' | 'entity';
  id: string;
  title: string;
  itemKind: string | null;
  entityType: string | null;
  check: 'hit' | 'miss' | 'no-text';
  snippet: string;
  matchStart: number;
  matchEnd: number;
}

interface Response {
  query: string;
  mode: string;
  route: string;
  hits: Hit[];
  candidates: number;
  checked: number;
  verified: number;
  notices: string[];
  tookMs: number;
}

async function openDb(): Promise<DatabaseSync> {
  const opened = await openCaseDatabase(join(caseFolder, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(`開不了資料庫：${opened.kind}`);
  return opened.db;
}

/** 一份走完擷取管線的資料：`item` 一列、索引、以及 `derived/` 的正文。 */
async function addDoc(
  db: DatabaseSync,
  input: { id: string; title: string; text: string; lang?: string; kind?: string },
): Promise<void> {
  const lang = input.lang ?? 'cmn';
  db.prepare(
    `INSERT INTO item (id, kind, title, title_rank, lang, status, low_confidence,
                       extractor_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'included', 0, 1, 1000, 1000)`,
  ).run(input.id, input.kind ?? 'web', input.title, input.id, lang);

  indexText(db, {
    ownerKind: 'item',
    ownerId: input.id,
    lang,
    title: input.title,
    text: input.text,
  });

  await writeDerived(caseFolder, input.id, {
    extractorVersion: EXTRACTOR_VERSION,
    kind: 'web',
    title: input.title,
    text: input.text,
    html: null,
    pages: null,
    excerpt: input.text.slice(0, 60),
    lowConfidence: false,
    reasons: [],
  });
}

async function search(q: string, extra = ''): Promise<Envelope<Response>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/cases/${slug}/search?q=${encodeURIComponent(q)}${extra}`,
  });
  return res.json() as Envelope<Response>;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-search-'));
  const localAppData = join(sandbox, 'LocalAppData');
  dataRoot = join(sandbox, 'DataRoot');
  await mkdir(localAppData, { recursive: true });
  savedLocalAppData = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = localAppData;

  const built = await buildServer();
  app = built.app;
  await app.ready();

  await app.inject({ method: 'POST', url: '/api/system/data-root', payload: { dataRoot } });
  const created = await app.inject({
    method: 'POST',
    url: '/api/cases',
    payload: { name: '檢索驗收' },
  });
  slug = (created.json() as { data: { slug: string } }).data.slug;
  caseFolder = join(dataRoot, 'cases', slug);

  const db = await openDb();
  try {
    await addDoc(db, {
      id: 'itm-tsmc',
      title: '台積電法說會紀錄',
      text: '台積電今天公布財報，先進製程的產能仍然吃緊。',
    });
    // **這一份是誤中的來源**：它有「台積」也有「積電」，但沒有「台積電」
    await addDoc(db, {
      id: 'itm-noise',
      title: '產業座談會後記',
      text: '他來台積極參與這場座談，會後又累積電力調度的資料。',
    });
    await addDoc(db, {
      id: 'itm-covid',
      title: '疫情期間的通勤紀錄',
      text: '疫情讓通勤方式整個改變，而那個改變沒有回去。',
    });
    // **中文頁面裡的拉丁學名** —— 這一份是那個索引缺口的證人
    await addDoc(db, {
      id: 'itm-zh-latin',
      title: '蓬萊塵蛛的網上裝飾行為',
      text: '蓬萊塵蛛（Cyclosa formosana）是台灣特有種，牠會把獵物殘骸排成一條隱帶。',
    });
    await addDoc(db, {
      id: 'itm-en',
      title: 'Web decorations of orb-weaver spiders',
      text: 'The genus Cyclosa builds conspicuous web decorations from prey remains.',
      lang: 'eng',
    });
    reindexTitleRank(db);
  } finally {
    db.close();
  }
});

afterEach(async () => {
  await app?.close();
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  await rm(sandbox, { recursive: true, force: true });
});

describe('中文', () => {
  it('**兩個字查得到** —— 這是 trigram 命中 0 列那個反例的驗收', async () => {
    const r = await search('疫情');
    expect(r.ok).toBe(true);
    expect(r.data?.route).toBe('bigram');
    expect(r.data?.hits.map((h) => h.id)).toContain('itm-covid');
  });

  it('**跨詞誤中排在後面而且標成 miss**，不是被丟掉', async () => {
    const r = await search('台積電');
    const hits = r.data?.hits ?? [];
    // 兩份都是候選（兩個 gram 都在），而只有一份真的有那三個字
    expect(hits.map((h) => h.id)).toEqual(['itm-tsmc', 'itm-noise']);
    expect(hits[0]?.check).toBe('hit');
    expect(hits[1]?.check).toBe('miss');
    // **`verified` 與 `hits.length` 不一樣，而差額正是誤中**
    expect(r.data?.verified).toBe(1);
    expect(r.data?.candidates).toBe(2);
  });

  it('標題命中的排在正文命中的前面', async () => {
    const db = await openDb();
    try {
      await addDoc(db, {
        id: 'itm-body',
        title: '一份不相干的筆記',
        text: '這一段中間才提到疫情兩個字。',
      });
      reindexTitleRank(db);
    } finally {
      db.close();
    }
    const r = await search('疫情');
    expect(r.data?.hits[0]?.id).toBe('itm-covid');
  });

  it('摘要指得到命中的那幾個字', async () => {
    const r = await search('先進製程');
    const hit = r.data?.hits[0];
    expect(hit?.id).toBe('itm-tsmc');
    expect(hit?.snippet.slice(hit.matchStart, hit.matchEnd)).toBe('先進製程');
  });
});

describe('拉丁文走 FTS5', () => {
  it('英文查得到，而且大小寫不影響', async () => {
    const r = await search('cyclosa');
    expect(r.data?.route).toBe('fts');
    expect(r.data?.hits.map((h) => h.id)).toContain('itm-en');
    expect(r.data?.hits[0]?.check).toBe('hit');
  });

  it('**中文頁面裡的拉丁學名查得到** —— 它以前一個索引都進不去', async () => {
    const r = await search('Cyclosa formosana');
    expect(r.data?.hits.map((h) => h.id)).toContain('itm-zh-latin');
    expect(r.data?.hits.find((h) => h.id === 'itm-zh-latin')?.check).toBe('hit');
  });

  it('查詢裡的 FTS5 語法不會變成語法 —— 它是要找的字，不是運算子', async () => {
    const r = await search('spiders OR nothing');
    expect(r.ok).toBe(true);
    // 整串當片語找 → 沒有這串字，所以不該把所有英文文件都撈回來
    expect(r.data?.hits.map((h) => h.id)).not.toContain('itm-en');
  });
});

describe('實體用名字找，不走索引', () => {
  it('名字含這串字的實體回得來，而且排在資料前面', async () => {
    const db = await openDb();
    try {
      db.prepare(
        `INSERT INTO entity (id, type, name_zh, title_rank, aliases_json, created_at, updated_at)
         VALUES ('ent-1', 'org', '台積電', '00000001', '[]', 1000, 1000)`,
      ).run();
    } finally {
      db.close();
    }
    const r = await search('台積電');
    expect(r.data?.hits[0]?.kind).toBe('entity');
    expect(r.data?.hits[0]?.entityType).toBe('org');
  });
});

describe('三種狀態分得出來', () => {
  it('**正文檔案不在 → no-text，不是 miss** —— 那是不知道，不是不對', async () => {
    await removeDerived(caseFolder, 'itm-covid');
    const r = await search('疫情');
    const hit = r.data?.hits.find((h) => h.id === 'itm-covid');
    expect(hit?.check).toBe('no-text');
  });

  it('點註沒有 derived，驗的是它自己那段字', async () => {
    const db = await openDb();
    try {
      db.prepare(
        `INSERT INTO item (id, kind, title, title_rank, lang, status, low_confidence,
                           created_at, updated_at)
         VALUES ('itm-note', 'note', '一則點註', 'zz', 'cmn', 'included', 0, 1000, 1000)`,
      ).run();
      setExcerpt(db, 'itm-note', '這一段值得記下來：颱風假的判準每年都在吵。');
      indexText(db, {
        ownerKind: 'item',
        ownerId: 'itm-note',
        lang: 'cmn',
        title: '一則點註',
        text: '這一段值得記下來：颱風假的判準每年都在吵。',
      });
    } finally {
      db.close();
    }
    const r = await search('颱風假');
    expect(r.data?.hits[0]?.id).toBe('itm-note');
    expect(r.data?.hits[0]?.check).toBe('hit');
    expect(r.data?.hits[0]?.itemKind).toBe('note');
  });
});

describe('說出結果可能不完整', () => {
  it('有作業在跑 → SEARCH_INDEX_INCOMPLETE（notice，結果照常回）', async () => {
    const db = await openDb();
    try {
      insertRun(db, {
        id: 'run-1',
        kind: 'import',
        label: '匯入中',
        total: 10,
        correlationId: 'cid',
        now: 1000,
      });
      db.prepare(`UPDATE run SET status = 'running' WHERE id = 'run-1'`).run();
    } finally {
      db.close();
    }
    const r = await search('疫情');
    expect(r.ok).toBe(true);
    expect(r.data?.notices).toContain('SEARCH_INDEX_INCOMPLETE');
    expect(r.data?.hits.length).toBeGreaterThan(0);
  });

  it('**要語意的時候不假裝有** —— 全文照常回，並標示語意沒跑', async () => {
    const r = await search('疫情', '&mode=hybrid');
    expect(r.ok).toBe(true);
    expect(r.data?.notices).toContain('SEARCH_EMBED_UNAVAILABLE');
    expect(r.data?.hits.length).toBeGreaterThan(0);
  });
});

describe('失敗路徑', () => {
  it('空查詢 → SEARCH_QUERY_EMPTY（400）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/cases/${slug}/search?q=%20%20` });
    expect(res.statusCode).toBe(400);
    expect((res.json() as Envelope<unknown>).code).toBe('SEARCH_QUERY_EMPTY');
  });

  it('不存在的專題 → CASE_NOT_FOUND（404）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/cases/nope/search?q=%E7%96%AB%E6%83%85',
    });
    expect(res.statusCode).toBe(404);
  });

  it('查一個沒有人提過的詞 → 空清單，不是錯誤', async () => {
    const r = await search('完全沒有人寫過這個詞');
    expect(r.ok).toBe(true);
    expect(r.data?.hits).toEqual([]);
  });
});
