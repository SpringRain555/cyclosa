/**
 * 端對端：證據包匯出。
 *
 * **這一份就是 Phase H 的驗收條件本身**：
 * 「匯出的每條引文都能回溯到 `item` 與字元區間」。
 *
 * 而「回溯得到」在這裡不是一句形容 —— 是一段會跑的程式：
 * 拿 `evidence.jsonl` 的 `itemId` 去讀 `derived/`，
 * 用 `charStart`／`charEnd` 切一刀，**切出來的必須一字不差等於 `quote`**。
 *
 * 三件事這一份要證明，而第三件最容易被漏掉：
 *
 * 1. 每條引文都回溯得到。
 * 2. **`derived/` 重算過之後仍然回溯得到** —— 位置會變，引文不會。
 * 3. **回溯不到的那幾條照樣出現在檔案裡而且標明了。**
 *    省略它們不會讓任何測試變紅，而那正是它需要一條測試的理由。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { buildServer } from '../../src/server.js';
import { createNote } from '../../src/application/note-service.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import {
  insertEdge,
  insertEvidence,
  setStatus,
} from '../../src/infrastructure/db/repositories/edge-repo.js';
import {
  EXTRACTOR_VERSION,
  derivedPath,
  writeDerived,
} from '../../src/infrastructure/fs/case-files.js';

let sandbox = '';
let dataRoot = '';
let slug = '';
let caseFolder = '';
let app: FastifyInstance;
let savedLocalAppData: string | undefined;

/** 焦點那一份的正文。**引文的字元位移全部以它為準。** */
const TEXT_A = [
  '這是第一段，講的是別的事情。',
  '',
  '甲公司在二○二四年三月收購了乙公司的全部股份。',
  '',
  '第三段又是別的事。',
].join('\n');

const TEXT_FAR = [
  '這一份沒有出現在選取範圍裡，但它是上面那條關聯的出處。',
  '',
  '主管機關在同年五月核准了那樁收購案。',
].join('\n');

const QUOTE_A = '甲公司在二○二四年三月收購了乙公司的全部股份。';
const QUOTE_FAR = '主管機關在同年五月核准了那樁收購案。';

interface Envelope<T> {
  ok: boolean;
  code?: string;
  data?: T;
}

interface Summary {
  folder: string;
  files: string[];
  nodeCount: number;
  edgeCount: number;
  noteCount: number;
  sourceCount: number;
  quoteCount: number;
  verified: number;
  shifted: number;
  missing: number;
  projectedOmitted: number;
  notice: string | null;
}

interface Row {
  kind: 'edge' | 'note';
  ownerId: string;
  itemId: string;
  quote: string;
  charStart: number;
  charEnd: number;
  status: 'verified' | 'shifted' | 'missing';
}

async function openDb(): Promise<DatabaseSync> {
  const opened = await openCaseDatabase(join(caseFolder, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(`開不了資料庫：${opened.kind}`);
  return opened.db;
}

function addDoc(db: DatabaseSync, id: string, title: string, url: string): void {
  db.prepare(
    `INSERT INTO item (id, kind, title, title_rank, requested_url, source_url, lang, sha256,
                       source_ext, fetched_at, status, low_confidence, extractor_version,
                       created_at, updated_at)
     VALUES (?, 'web', ?, ?, ?, ?, 'zh', ?, 'html', 1000, 'included', 0, ?, 1000, 1000)`,
  ).run(id, title, title, url, url, `${id}-sha`, EXTRACTOR_VERSION);
}

async function writeText(id: string, title: string, text: string): Promise<void> {
  await writeDerived(caseFolder, id, {
    extractorVersion: EXTRACTOR_VERSION,
    kind: 'web',
    title,
    text,
    html: null,
    pages: null,
    excerpt: text.slice(0, 100),
    lowConfidence: false,
    reasons: [],
  });
}

/** 送出跟畫面上同一組參數。**焦點是 `itm-a`，一跳。** */
async function exportPack(body: Record<string, unknown> = {}): Promise<Envelope<Summary>> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/cases/${slug}/export/evidence`,
    payload: { focus: 'itm-a', hops: '1', status: 'pending,confirmed,rejected', ...body },
  });
  return res.json() as Envelope<Summary>;
}

async function readRows(folder: string): Promise<readonly Row[]> {
  const raw = await readFile(join(folder, 'evidence.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Row);
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-export-'));
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
    payload: { name: '證據包驗收' },
  });
  slug = (created.json() as { data: { slug: string } }).data.slug;
  caseFolder = join(dataRoot, 'cases', slug);

  await writeText('itm-a', '第一份報導', TEXT_A);
  await writeText('itm-b', '第二份報導', '乙公司的公告全文。');
  await writeText('itm-far', '主管機關的公告', TEXT_FAR);

  const db = await openDb();
  try {
    addDoc(db, 'itm-a', '第一份報導', 'https://example.test/a');
    addDoc(db, 'itm-b', '第二份報導', 'https://example.test/b');
    // **這一份不會出現在選取範圍裡**（它沒有任何一條邊），
    // 但它是那條關聯的出處 —— 證據包必須自帶它。
    addDoc(db, 'itm-far', '主管機關的公告', 'https://example.test/far');

    // 已確認：機器建的邊要先有出處才確認得了（schema 的觸發器守著）。
    const confirmed = insertEdge(
      db,
      {
        layer: 'named',
        rel: '收購',
        source: 'itm-a',
        sourceKind: 'item',
        target: 'itm-b',
        targetKind: 'item',
        origin: 'machine',
        confidence: 0.9,
      },
      1000,
    );
    insertEvidence(
      db,
      confirmed,
      [
        {
          itemId: 'itm-a',
          quote: QUOTE_A,
          charStart: TEXT_A.indexOf(QUOTE_A),
          charEnd: TEXT_A.indexOf(QUOTE_A) + QUOTE_A.length,
        },
        {
          itemId: 'itm-far',
          quote: QUOTE_FAR,
          charStart: TEXT_FAR.indexOf(QUOTE_FAR),
          charEnd: TEXT_FAR.indexOf(QUOTE_FAR) + QUOTE_FAR.length,
        },
      ],
      1000,
    );
    setStatus(db, confirmed, 'confirmed', 1000);

    // 待查證
    const pending = insertEdge(
      db,
      {
        layer: 'named',
        rel: '公告',
        source: 'itm-a',
        sourceKind: 'item',
        target: 'itm-b',
        targetKind: 'item',
        origin: 'machine',
        confidence: 0.4,
      },
      1000,
    );
    insertEvidence(
      db,
      pending,
      [
        {
          itemId: 'itm-a',
          quote: QUOTE_A,
          charStart: TEXT_A.indexOf(QUOTE_A),
          charEnd: TEXT_A.indexOf(QUOTE_A) + QUOTE_A.length,
        },
      ],
      1000,
    );

    // 已否決
    const rejected = insertEdge(
      db,
      {
        layer: 'named',
        rel: '否認',
        source: 'itm-a',
        sourceKind: 'item',
        target: 'itm-b',
        targetKind: 'item',
        origin: 'machine',
        confidence: 0.2,
      },
      1000,
    );
    setStatus(db, rejected, 'rejected', 1000);
  } finally {
    db.close();
  }

  // 點註走真的那條路 —— 它會連帶建出「註於」那條邊，
  // 所以它在焦點一跳之內看得到。
  const note = await createNote(dataRoot, slug, 'itm-a', {
    body: '這一句要回頭查一下。',
    start: TEXT_A.indexOf(QUOTE_A),
    end: TEXT_A.indexOf(QUOTE_A) + QUOTE_A.length,
  });
  if (!note.ok) throw new Error(`建不了點註：${note.code}`);
});

afterEach(async () => {
  await app?.close();
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  await rm(sandbox, { recursive: true, force: true });
});

describe('匯出的每條引文都能回溯到 item 與字元區間', () => {
  it('三個檔都產生了', async () => {
    const r = await exportPack();
    expect(r.ok).toBe(true);
    const summary = r.data as Summary;
    expect(summary.files).toEqual(['evidence-pack.md', 'sources.md', 'evidence.jsonl']);
    for (const file of summary.files) {
      const text = await readFile(join(summary.folder, file), 'utf8');
      expect(text.length).toBeGreaterThan(0);
    }
  });

  it('**逐條切回原文，一字不差** —— 這就是驗收條件', async () => {
    const r = await exportPack();
    const summary = r.data as Summary;
    const rows = await readRows(summary.folder);

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const raw = await readFile(derivedPath(caseFolder, row.itemId), 'utf8');
      const text = (JSON.parse(raw) as { text: string }).text;
      expect(text.slice(row.charStart, row.charEnd)).toBe(row.quote);
    }
  });

  it('全部都是已核對的，沒有回溯不到的', async () => {
    const summary = (await exportPack()).data as Summary;
    expect(summary.missing).toBe(0);
    expect(summary.shifted).toBe(0);
    expect(summary.verified).toBe(summary.quoteCount);
    expect(summary.notice).toBeNull();
  });

  it('Markdown 裡也寫著 id 與字元區間', async () => {
    const summary = (await exportPack()).data as Summary;
    const md = await readFile(join(summary.folder, 'evidence-pack.md'), 'utf8');
    expect(md).toContain('`itm-a`');
    const start = TEXT_A.indexOf(QUOTE_A);
    expect(md).toContain(`字元 ${String(start)}–${String(start + QUOTE_A.length)}`);
    expect(md).toContain(QUOTE_A);
  });

  it('出處那一份不在選取範圍裡，而來源清單照樣自帶它', async () => {
    const summary = (await exportPack()).data as Summary;
    const sources = await readFile(join(summary.folder, 'sources.md'), 'utf8');
    // itm-far 一條邊都沒有，所以它不在焦點一跳的子圖裡。
    expect(sources).toContain('itm-far');
    expect(sources).toContain('https://example.test/far');
  });

  it('點註的引文也回溯得到，而且標成 note', async () => {
    const summary = (await exportPack()).data as Summary;
    const rows = await readRows(summary.folder);
    const noteRows = rows.filter((row) => row.kind === 'note');
    expect(noteRows).toHaveLength(1);
    expect(noteRows[0]?.quote).toBe(QUOTE_A);
    expect(summary.noteCount).toBe(1);
  });

  it('已否決的只在 Markdown 裡列一行，不進 jsonl', async () => {
    const summary = (await exportPack()).data as Summary;
    const md = await readFile(join(summary.folder, 'evidence-pack.md'), 'utf8');
    expect(md).toContain('已否決的關聯（1 條）');
    expect(md).toContain('否認');

    const rows = await readRows(summary.folder);
    expect(rows.every((row) => row.quote.length > 0)).toBe(true);
    // 三條邊，但只有兩條帶引文（已否決的不進來）。
    expect(rows.filter((row) => row.kind === 'edge')).toHaveLength(3);
  });
});

describe('derived/ 重算過之後', () => {
  it('位置全部平移，而每一條仍然切得回一模一樣的引文', async () => {
    // 在最前面塞一段 —— 抽取器改版最常見的效果就是這個。
    await writeText('itm-a', '第一份報導', `多出來的一段前言。\n\n${TEXT_A}`);

    const summary = (await exportPack()).data as Summary;
    expect(summary.shifted).toBeGreaterThan(0);
    expect(summary.missing).toBe(0);

    const rows = await readRows(summary.folder);
    for (const row of rows) {
      const raw = await readFile(derivedPath(caseFolder, row.itemId), 'utf8');
      const text = (JSON.parse(raw) as { text: string }).text;
      expect(text.slice(row.charStart, row.charEnd)).toBe(row.quote);
    }
  });

  it('紀錄裡的舊位置也留著 —— 匯出不去改資料庫', async () => {
    await writeText('itm-a', '第一份報導', `多出來的一段前言。\n\n${TEXT_A}`);
    const summary = (await exportPack()).data as Summary;
    const md = await readFile(join(summary.folder, 'evidence-pack.md'), 'utf8');
    expect(md).toContain('位置已移動');

    const db = await openDb();
    try {
      const row = db
        .prepare('SELECT char_start AS s FROM edge_evidence WHERE item_id = ? LIMIT 1')
        .get('itm-a') as { s: number };
      // 資料庫裡還是原來那個位置。
      expect(Number(row.s)).toBe(TEXT_A.indexOf(QUOTE_A));
    } finally {
      db.close();
    }
  });
});

describe('回溯不到的時候', () => {
  it('檔案照樣產生，引文留在裡面而且標明了', async () => {
    await rm(derivedPath(caseFolder, 'itm-a'), { force: true });

    const r = await exportPack();
    expect(r.ok).toBe(true);
    const summary = r.data as Summary;
    expect(summary.missing).toBeGreaterThan(0);
    expect(summary.notice).toBe('EXPORT_EVIDENCE_MISSING');

    const md = await readFile(join(summary.folder, 'evidence-pack.md'), 'utf8');
    expect(md).toContain('回溯不到');
    // **引文本身沒有被省略。**
    expect(md).toContain(QUOTE_A);

    const rows = await readRows(summary.folder);
    const missing = rows.filter((row) => row.status === 'missing');
    expect(missing.length).toBeGreaterThan(0);
    // 回溯不到的那幾列**仍然帶著 itemId 與紀錄裡的區間** —— 那是去查的線索。
    for (const row of missing) {
      expect(row.itemId.length).toBeGreaterThan(0);
      expect(row.charEnd).toBeGreaterThan(row.charStart);
    }
  });

  it('其餘那些照樣是已核對的 —— 一份壞掉不影響別份', async () => {
    await rm(derivedPath(caseFolder, 'itm-a'), { force: true });
    const summary = (await exportPack()).data as Summary;
    expect(summary.verified).toBeGreaterThan(0);
  });
});

describe('選取範圍', () => {
  it('一個節點都沒選是一個錯誤，不是一份空檔案', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/cases/${slug}/export/evidence`,
      payload: { focus: 'itm-a', hops: '1', nodeIds: [] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as Envelope<unknown>).code).toBe('EXPORT_EMPTY_SELECTION');
  });

  it('只選兩個節點的話，只有兩端都在裡面的邊會被匯出', async () => {
    const summary = (await exportPack({ nodeIds: ['itm-a', 'itm-b'] })).data as Summary;
    expect(summary.nodeCount).toBe(2);
    expect(summary.edgeCount).toBe(3);
    // 點註那個節點沒選，所以它不在這一份裡。
    expect(summary.noteCount).toBe(0);
  });

  it('每次匯出一個新資料夾，不覆寫上一次', async () => {
    const first = (await exportPack()).data as Summary;
    // 資料夾名精確到秒，所以要確定兩次不同得先讓時間走過一秒。
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const second = (await exportPack()).data as Summary;
    expect(second.folder).not.toBe(first.folder);
    const still = await readFile(join(first.folder, 'evidence-pack.md'), 'utf8');
    expect(still.length).toBeGreaterThan(0);
  });
});
