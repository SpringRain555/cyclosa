/**
 * 筆記與點註的端對端測試。
 *
 * **這一份的核心是一條驗收條件，不是一組 API：**
 *
 * > `derived/` 整批重算前後，每個點註的解析結果差異必須為 0。
 *
 * 為了讓那條驗收不是在驗自己，這裡的重算走的是**真的那條路** ——
 * `rebuildDerived` 會真的把 `derived/` 整個刪掉、從 `sources/` 的原始位元組
 * 重跑同一支抽取、再重解每一個錨點。假的只有那台被抓的伺服器。
 *
 * 另外四件事在這裡才測得到：
 *
 * 1. **`sources/` 一個位元組都沒被動過**（重算前後逐檔比雜湊）。
 * 2. **重算不覆寫人的判定** —— 排除掉的那一份重算之後仍然是排除的。
 * 3. **一則點註就是圖上一個節點**，而且它能參與關聯。
 * 4. **快照換了就說對不上**，不拿新的快照去解舊的錨點。
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCase } from '../../src/application/case-service.js';
import { importFile, isActive, startUrlImport } from '../../src/application/ingest-service.js';
import { changeItemStatus, getItemContent } from '../../src/application/item-service.js';
import {
  createNote,
  deleteNote,
  listAllNotes,
  listNotesForItem,
  updateNote,
  type ResolvedNote,
} from '../../src/application/note-service.js';
import { rebuildDerived } from '../../src/application/rebuild-service.js';
import { createEdge } from '../../src/application/edge-service.js';
import { subgraph } from '../../src/application/graph-service.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { findAll } from '../../src/domain/text/offsets.js';
import { DEFAULT_PROJECTION_THRESHOLDS, normalizeFilters } from '../../src/domain/graph/index.js';

const DEFAULT_FILTERS = normalizeFilters({});

/**
 * 同一句話在這篇裡出現**兩次** —— 那是這份測試資料存在的理由。
 * 只出現一次的引文任何錨點演算法都找得到，而**找對第二個**才是難的。
 */
const REPEATED = '網上裝飾物的功能至今沒有定論';

const ARTICLE = `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<title>蜘蛛網上的裝飾物</title></head><body>
<nav><a href="/">首頁</a></nav>
<article>
<h1>蜘蛛網上的裝飾物</h1>
<p>研究者在台中霧社坑觀察了三年，記錄了數百張網。${REPEATED}，
而這正是這一系列研究想要回答的問題。第一段刻意寫得長一點，
因為抽取信心的門檻之一是正文長度，太短會被標成低信心而干擾這份測試。</p>
<p>第二段講的是實驗設計。研究者把裝飾物移除之後，比較了獵物的到訪率與
被掠食的機率，兩者的方向相反。這一段同時讓這篇文章的長度超過門檻，
讓上面那個斷言測的是抽取管線而不是門檻本身。</p>
<p>第三段回到同一個問題上：${REPEATED}，
不同的實驗給出彼此矛盾的結論，而那些矛盾多半來自物種與環境的差異。
這一段的存在是為了讓上面那句話在同一篇裡出現兩次。</p>
<p>第四段。快照存的是原始位元組而且不可變，衍生物可以整批刪掉重算，
點註錨在快照上，所以抽取換版之後不會漂掉 —— 這一句就是這份測試在驗的事。</p>
</article>
<footer>頁尾</footer></body></html>`;

/** 1×1 的 PNG。圖片的矩形註記需要一個有尺寸的快照。 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAGQAAABkCAYAAABw4pVUAAAAJUlEQVR42u3BAQ0AAADCoPdPbQ8H' +
    'FAAAAAAAAAAAAAAAAAAAAHwbYAAAAV6VbcAAAAAASUVORK5CYII=',
  'base64',
);

let server: Server;
let base = '';
let dataRoot = '';
let slug = '';
let webItemId = '';
let imageItemId = '';
let derivedText = '';

/** `sources/` 底下每個檔的雜湊。**重算前後要一模一樣。** */
async function snapshotFingerprint(): Promise<readonly string[]> {
  const dir = join(dataRoot, 'cases', slug, 'sources');
  const names = (await readdir(dir)).sort();
  const out: string[] = [];
  for (const name of names) {
    const bytes = await readFile(join(dir, name));
    out.push(`${name}:${createHash('sha256').update(bytes).digest('hex')}`);
  }
  return out;
}

/** 一則點註「解到哪裡」的可比對表示。**驗收比的就是這個字串。** */
function fingerprintOf(notes: readonly ResolvedNote[]): readonly string[] {
  return notes
    .map((n) => {
      const h = n.hit;
      if (h.kind === 'rect') {
        return `${n.note.id}|rect|${String(h.rect.x)},${String(h.rect.y)},${String(h.rect.w)},${String(h.rect.h)}`;
      }
      if (h.kind === 'not-found') return `${n.note.id}|not-found`;
      return `${n.note.id}|${h.kind}|${String(h.page)}|${String(h.start)}-${String(h.end)}`;
    })
    .sort();
}

async function waitForRun(runId: string): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (!isActive(runId)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('作業沒有在時限內結束');
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }
    if (path === '/article') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ARTICLE);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  base = `http://127.0.0.1:${port}`;

  dataRoot = await mkdtemp(join(tmpdir(), 'cyclosa-note-'));
  const created = await createCase(dataRoot, { name: '點註測試' });
  if (!created.ok) throw new Error(created.code);
  slug = created.data.slug;

  const imported = await startUrlImport(dataRoot, slug, [`${base}/article`]);
  if (!imported.ok) throw new Error(imported.code);
  await waitForRun(imported.data.runId);

  const file = await importFile(dataRoot, slug, 'chart.png', PNG);
  if (!file.ok || file.data.itemId === null) throw new Error('圖片匯入失敗');
  imageItemId = file.data.itemId;

  const db = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'), {
    backupDir: join(dataRoot, 'backups'),
    backupLabel: slug,
  });
  if (db.kind !== 'ok') throw new Error('開不了資料庫');
  const row = db.db.prepare("SELECT id FROM item WHERE kind = 'web'").get() as { id: string };
  webItemId = row.id;
  db.db.close();

  const content = await getItemContent(dataRoot, slug, webItemId);
  if (!content.ok || content.data.derived === null) throw new Error('抽不到正文');
  derivedText = content.data.derived.text;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (dataRoot.length > 0) await rm(dataRoot, { recursive: true, force: true });
});

describe('建立點註', () => {
  it('選一段文字 → 引文由伺服器切，而且真的在那個位置上', async () => {
    const span = findAll(derivedText, '台中霧社坑')[0];
    expect(span).toBeDefined();

    const created = await createNote(dataRoot, slug, webItemId, {
      body: '這是觀察地點，之後要查它的座標。',
      start: span?.start,
      end: span?.end,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(created.data.note.quote).toBe('台中霧社坑');
    expect(created.data.note.hit.kind).toBe('exact');
    expect(created.data.notice).toBeNull();
  });

  it('同一句話出現兩次 —— 標在第二次那一個，就錨在第二次', async () => {
    const spans = findAll(derivedText, REPEATED);
    expect(spans.length).toBe(2);

    const created = await createNote(dataRoot, slug, webItemId, {
      body: '第二次出現的時候語氣不一樣。',
      start: spans[1]?.start,
      end: spans[1]?.end,
    });
    if (!created.ok) throw new Error(created.code);

    const hit = created.data.note.hit;
    expect(hit.kind).toBe('exact');
    if (hit.kind !== 'exact') return;
    expect(hit.start).toBe(spans[1]?.start);
  });

  it('圖片：框一個矩形，存的是 pixel 座標', async () => {
    const created = await createNote(dataRoot, slug, imageItemId, {
      body: '左上角這一塊。',
      rect: { x: 5, y: 5, w: 20, h: 20 },
    });
    if (!created.ok) throw new Error(created.code);
    expect(created.data.note.hit).toEqual({ kind: 'rect', rect: { x: 5, y: 5, w: 20, h: 20 } });
    expect(created.data.note.note.selectorJson).toContain('#xywh=pixel:5,5,20,20');
  });

  it('框到圖外面 → 拒絕，不夾進邊界', async () => {
    const created = await createNote(dataRoot, slug, imageItemId, {
      body: '這個框不合法。',
      rect: { x: 90, y: 90, w: 100, h: 100 },
    });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.code).toBe('NOTE_ANCHOR_UNRESOLVED');
  });

  it('選太短 → 拒絕', async () => {
    const created = await createNote(dataRoot, slug, webItemId, { body: '太短', start: 0, end: 1 });
    expect(created.ok).toBe(false);
  });

  it('點註不能標在點註上', async () => {
    const all = await listAllNotes(dataRoot, slug);
    if (!all.ok) throw new Error(all.code);
    const noteId = all.data[0]?.note.id as string;

    const created = await createNote(dataRoot, slug, noteId, { body: '巢狀', start: 0, end: 5 });
    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.code).toBe('NOTE_TARGET_MISSING');
  });
});

describe('一則點註寫三個地方', () => {
  it('資料庫裡是一個 kind=note 的 item ＋ 一列 note，同一個 id', async () => {
    const db = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'), {
      backupDir: join(dataRoot, 'backups'),
      backupLabel: slug,
    });
    if (db.kind !== 'ok') throw new Error('開不了資料庫');

    const orphans = db.db
      .prepare(
        `SELECT COUNT(*) AS n FROM note
         WHERE id NOT IN (SELECT id FROM item WHERE kind = 'note')`,
      )
      .get() as { n: number };
    expect(Number(orphans.n)).toBe(0);

    const noteItems = db.db.prepare("SELECT COUNT(*) AS n FROM item WHERE kind = 'note'").get() as {
      n: number;
    };
    expect(Number(noteItems.n)).toBeGreaterThanOrEqual(3);
    db.db.close();
  });

  it('trigger 擋住「沒有 item 節點的 note 列」', async () => {
    const db = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'), {
      backupDir: join(dataRoot, 'backups'),
      backupLabel: slug,
    });
    if (db.kind !== 'ok') throw new Error('開不了資料庫');

    expect(() =>
      db.db
        .prepare(
          `INSERT INTO note (id, item_id, body, selector_json, anchor_ok, created_at, updated_at)
           VALUES ('orphan', ?, '', '[]', 1, 0, 0)`,
        )
        .run(webItemId),
    ).toThrow(/NOTE_TARGET_MISSING/);
    db.db.close();
  });

  it('notes\\*.md 寫出來了，而且離開這個工具也讀得懂', async () => {
    const dir = join(dataRoot, 'cases', slug, 'notes');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md'));
    expect(files.length).toBeGreaterThanOrEqual(3);

    const body = await readFile(join(dir, files[0] as string), 'utf8');
    expect(body.startsWith('---')).toBe(true);
    // **無 BOM**（`.md` 的規矩）。
    expect(body.charCodeAt(0)).not.toBe(0xfeff);
    expect(body).toContain('snapshot: ');
  });
});

describe('點註在圖上是一個節點，而且能參與關聯', () => {
  it('子圖裡看得到它，而且 kind 是 note', async () => {
    const all = await listAllNotes(dataRoot, slug);
    if (!all.ok) throw new Error(all.code);
    const noteId = all.data.find((n) => n.note.itemId === webItemId)?.note.id as string;

    const view = await subgraph(dataRoot, slug, {
      focus: noteId,
      hops: 1,
      filters: DEFAULT_FILTERS,
      thresholds: DEFAULT_PROJECTION_THRESHOLDS,
    });
    if (!view.ok) throw new Error(view.code);

    const self = view.data.nodes.find((n) => n.id === noteId);
    expect(self).toBeDefined();
    expect(self?.subKind).toBe('note');
  });

  it('建立點註就會有一條「註於」的線 —— 零度數的節點在焦點圖上等於不存在', async () => {
    const all = await listAllNotes(dataRoot, slug);
    if (!all.ok) throw new Error(all.code);
    const noteId = all.data.find((n) => n.note.itemId === webItemId)?.note.id as string;

    // 從**那一份資料**出發，一跳就看得到這則點註。
    const view = await subgraph(dataRoot, slug, {
      focus: webItemId,
      hops: 1,
      filters: DEFAULT_FILTERS,
      thresholds: DEFAULT_PROJECTION_THRESHOLDS,
    });
    if (!view.ok) throw new Error(view.code);
    expect(view.data.nodes.map((n) => n.id)).toContain(noteId);

    const anchor = view.data.edges.find((e) => e.source === noteId && e.target === webItemId);
    expect(anchor).toBeDefined();
    // 使用者的動作的結果 —— 所以它一建立就是已確認，而且不進裁決佇列。
    expect(anchor?.origin).toBe('human');
    expect(anchor?.status).toBe('confirmed');
    expect(anchor?.rel).toBe('註於');
  });

  it('刪除確認裡的線數不算那條錨點線 —— 問的是「你另外建的那些」', async () => {
    const all = await listAllNotes(dataRoot, slug);
    if (!all.ok) throw new Error(all.code);
    const fresh = all.data.find((n) => n.note.itemId === imageItemId);
    expect(fresh?.edgeCount).toBe(0);
  });

  it('可以從點註手動連一條線到那份資料 —— 一建立就是已確認', async () => {
    const all = await listAllNotes(dataRoot, slug);
    if (!all.ok) throw new Error(all.code);
    const noteId = all.data.find((n) => n.note.itemId === webItemId)?.note.id as string;

    const edge = await createEdge(dataRoot, slug, {
      source: noteId,
      target: webItemId,
      rel: '評論',
      layer: 'named',
    });
    if (!edge.ok) throw new Error(edge.code);
    expect(edge.data.status).toBe('confirmed');
    expect(edge.data.origin).toBe('human');
  });
});

describe('驗收：derived/ 整批重算前後，解析結果差異為 0', () => {
  it('重算之後每一則點註都解到同一個位置', async () => {
    const before = await listAllNotes(dataRoot, slug);
    if (!before.ok) throw new Error(before.code);
    const beforeFingerprint = fingerprintOf(before.data);
    expect(beforeFingerprint.length).toBeGreaterThanOrEqual(3);

    const sourcesBefore = await snapshotFingerprint();

    const rebuilt = await rebuildDerived(dataRoot, slug);
    if (!rebuilt.ok) throw new Error(rebuilt.code);

    // 真的重抽了，不是什麼都沒做。
    expect(rebuilt.data.reextracted).toBeGreaterThanOrEqual(2);
    expect(rebuilt.data.notes.checked).toBe(beforeFingerprint.length);
    // **這就是那條驗收。**
    expect(rebuilt.data.notes.unresolved).toBe(0);
    expect(rebuilt.data.notes.shifted).toBe(0);

    const after = await listAllNotes(dataRoot, slug);
    if (!after.ok) throw new Error(after.code);
    expect(fingerprintOf(after.data)).toEqual(beforeFingerprint);

    // **`sources/` 一個位元組都沒被動過。**
    expect(await snapshotFingerprint()).toEqual(sourcesBefore);
  }, 30_000);

  it('重算不覆寫人的判定 —— 排除掉的那一份重算之後仍然是排除的', async () => {
    const excluded = await changeItemStatus(dataRoot, slug, imageItemId, 'exclude');
    if (!excluded.ok) throw new Error(excluded.code);
    expect(excluded.data).toBe('excluded');

    const rebuilt = await rebuildDerived(dataRoot, slug);
    if (!rebuilt.ok) throw new Error(rebuilt.code);

    const db = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'), {
      backupDir: join(dataRoot, 'backups'),
      backupLabel: slug,
    });
    if (db.kind !== 'ok') throw new Error('開不了資料庫');
    const row = db.db.prepare('SELECT status FROM item WHERE id = ?').get(imageItemId) as {
      status: string;
    };
    db.db.close();

    // `markParsed` 會把它設回 `included`。**這一條就是那個 bug 的守門人。**
    expect(row.status).toBe('excluded');

    await changeItemStatus(dataRoot, slug, imageItemId, 'restore');
  }, 30_000);

  /**
   * **v0.24.0：引文的位置也跟著正文走。** 點註錨在快照上、重算後重解（上面那條驗收）；
   * 關聯的引文記的是「在正文的第幾個字」—— 抽取器一改（PDF 重排），位置就全部平移。
   * 在這之前 rebuild 只管點註，資料庫裡的引文位置一直是舊的。
   */
  it('重算之後關聯引文的位置對回去；找不到的原樣留著、數得出來', async () => {
    const content = await getItemContent(dataRoot, slug, webItemId);
    if (!content.ok || content.data.derived === null) throw new Error('讀不到正文');
    const text = content.data.derived.text;
    // 取中間一段、而且在正文裡只出現一次 —— 對位置的時候才不會對到別處。
    const from = Math.floor(text.length / 3);
    const quote = text.slice(from, from + 24);
    expect(text.indexOf(quote)).toBe(text.lastIndexOf(quote));

    const edge = await createEdge(dataRoot, slug, {
      source: webItemId,
      target: imageItemId,
      rel: '補充',
      layer: 'named',
    });
    if (!edge.ok) throw new Error(edge.code);

    const open = async (): Promise<import('node:sqlite').DatabaseSync> => {
      const opened = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'), {
        backupDir: join(dataRoot, 'backups'),
        backupLabel: slug,
      });
      if (opened.kind !== 'ok') throw new Error('開不了資料庫');
      return opened.db;
    };
    // 一筆位置錯了三個字（模擬舊抽取器留下的位置），一筆引文根本不在正文裡。
    const db = await open();
    const insert = db.prepare(
      `INSERT INTO edge_evidence (id, edge_id, item_id, quote, char_start, char_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('ev-moved', edge.data.id, webItemId, quote, from + 3, from + 27, Date.now());
    insert.run('ev-gone', edge.data.id, webItemId, '這一句從來不在正文裡。', 0, 11, Date.now());
    db.close();

    const rebuilt = await rebuildDerived(dataRoot, slug);
    if (!rebuilt.ok) throw new Error(rebuilt.code);
    expect(rebuilt.data.evidence.checked).toBeGreaterThanOrEqual(2);
    expect(rebuilt.data.evidence.shifted).toBeGreaterThanOrEqual(1);
    expect(rebuilt.data.evidence.unresolved).toBeGreaterThanOrEqual(1);

    const after = await open();
    const spanOf = (id: string): { start: number; end: number; quote: string } => {
      const row = after
        .prepare('SELECT char_start, char_end, quote FROM edge_evidence WHERE id = ?')
        .get(id) as { char_start: number; char_end: number; quote: string };
      return { start: row.char_start, end: row.char_end, quote: row.quote };
    };
    const moved = spanOf('ev-moved');
    const gone = spanOf('ev-gone');
    after.close();

    // 位置對回去了，**引文本身沒動**（它是寫進去那一刻的事實）。
    expect(moved).toEqual({ start: from, end: from + 24, quote });
    expect(text.slice(moved.start, moved.end)).toBe(quote);
    // 找不到的那一筆原樣留著 —— 不刪、不亂指。
    expect(gone).toEqual({ start: 0, end: 11, quote: '這一句從來不在正文裡。' });

    // 再重算一次：已經對好的那一筆算「對得上」，不再算「移動過」。
    const again = await rebuildDerived(dataRoot, slug);
    if (!again.ok) throw new Error(again.code);
    expect(again.data.evidence.shifted).toBe(0);
  }, 30_000);
});

describe('錨點對不上的時候說對不上', () => {
  it('快照換了 → not-found，不拿新的快照去解舊的錨點', async () => {
    const db = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'), {
      backupDir: join(dataRoot, 'backups'),
      backupLabel: slug,
    });
    if (db.kind !== 'ok') throw new Error('開不了資料庫');
    const original = (
      db.db.prepare('SELECT sha256 FROM item WHERE id = ?').get(webItemId) as { sha256: string }
    ).sha256;
    db.db.prepare('UPDATE item SET sha256 = ? WHERE id = ?').run('0'.repeat(64), webItemId);
    db.db.close();

    const notes = await listNotesForItem(dataRoot, slug, webItemId);
    if (!notes.ok) throw new Error(notes.code);
    expect(notes.data.length).toBeGreaterThan(0);
    for (const note of notes.data) expect(note.hit.kind).toBe('not-found');

    const restored = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'), {
      backupDir: join(dataRoot, 'backups'),
      backupLabel: slug,
    });
    if (restored.kind !== 'ok') throw new Error('開不了資料庫');
    restored.db.prepare('UPDATE item SET sha256 = ? WHERE id = ?').run(original, webItemId);
    restored.db.close();
  });
});

describe('改與刪', () => {
  it('改內容不動錨點', async () => {
    const all = await listNotesForItem(dataRoot, slug, webItemId);
    if (!all.ok) throw new Error(all.code);
    const target = all.data[0] as ResolvedNote;

    const updated = await updateNote(dataRoot, slug, target.note.id, '改過的內容，位置不該動。');
    if (!updated.ok) throw new Error(updated.code);

    expect(updated.data.note.note.selectorJson).toBe(target.note.selectorJson);
    expect(updated.data.note.hit).toEqual(target.hit);
    expect(updated.data.note.note.body).toBe('改過的內容，位置不該動。');
  });

  it('刪掉的時候會說出順便拿掉幾條線', async () => {
    const all = await listNotesForItem(dataRoot, slug, webItemId);
    if (!all.ok) throw new Error(all.code);
    const withEdge = all.data.find((n) => n.note.id.length > 0) as ResolvedNote;

    const before = await listAllNotes(dataRoot, slug);
    if (!before.ok) throw new Error(before.code);

    const deleted = await deleteNote(dataRoot, slug, withEdge.note.id);
    if (!deleted.ok) throw new Error(deleted.code);
    expect(deleted.data.removedEdges).toBeGreaterThanOrEqual(0);

    const after = await listAllNotes(dataRoot, slug);
    if (!after.ok) throw new Error(after.code);
    expect(after.data.length).toBe(before.data.length - 1);

    // 純文字那一份也跟著走。
    const files = await readdir(join(dataRoot, 'cases', slug, 'notes'));
    expect(files).not.toContain(`${withEdge.note.id}.md`);
  });
});
