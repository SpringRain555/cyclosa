import { mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import { createCase } from '../../src/application/case-service.js';
import { importFile } from '../../src/application/ingest-service.js';
import {
  deleteNote,
  createNote,
  updateNote,
  listNotesForItem,
  type CreatedNote,
} from '../../src/application/note-service.js';
import { searchCase } from '../../src/application/search-service.js';
import { rebuildDerived } from '../../src/application/rebuild-service.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { insertReference } from '../../src/infrastructure/db/repositories/item-repo.js';
import type { Result } from '../../src/shared/result.js';

let root: string;
let slug: string;
let itemId: string;
let folder: string;
let db: DatabaseSync;
let app: FastifyInstance;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cyclosa-note-file-'));
  const created = await createCase(root, { name: '附件測試' });
  if (!created.ok) throw new Error(created.code);
  slug = created.data.slug;
  folder = join(root, 'cases', slug);
  const imported = await importFile(root, slug, 'source.md', Buffer.from('# 來源\n合成測試正文。'));
  if (!imported.ok || imported.data.itemId === null) throw new Error('import failed');
  itemId = imported.data.itemId;
  const opened = await openCaseDatabase(join(folder, 'case.sqlite'), { create: false });
  if (opened.kind !== 'ok') throw new Error('database failed');
  db = opened.db;
  const built = await buildServer();
  built.ctx.dataRoot = root;
  app = built.app;
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  db?.close();
  await rm(root, { recursive: true, force: true });
});

async function upload(body: string, name = '研究筆記.md', target = itemId) {
  return app.inject({
    method: 'POST',
    url: `/api/cases/${slug}/items/${target}/note-files`,
    headers: {
      'content-type': 'application/octet-stream',
      'x-file-name': encodeURIComponent(name),
    },
    payload: Buffer.from(body),
  });
}

async function attach(body: string, name?: string) {
  const res = await upload(body, name);
  expect(res.statusCode).toBe(200);
  const result = res.json<Result<CreatedNote>>();
  if (!result.ok) throw new Error(result.code);
  expect(result.data.note.edgeCount).toBe(0);
  return result.data.note.note;
}

describe('筆記檔的真實接收、儲存與關聯', () => {
  it('搜尋一般點註開所屬資料，來源已刪除的筆記不提供錯誤閱讀目標', async () => {
    const ordinary = await createNote(root, slug, itemId, {
      start: 0,
      end: 6,
      body: 'ordinaryreadertarget',
    });
    if (!ordinary.ok) throw new Error('note failed');
    const noteId = ordinary.data.note.note.id;
    const found = await searchCase(root, slug, { q: 'ordinaryreadertarget' });
    expect(found.ok && found.data.hits.find((hit) => hit.id === noteId)).toMatchObject({
      readerTarget: { itemId, noteId },
    });
    db.prepare('UPDATE note SET item_id = NULL WHERE id = ?').run(noteId);
    const orphan = await searchCase(root, slug, { q: 'ordinaryreadertarget' });
    expect(orphan.ok && orphan.data.hits.find((hit) => hit.id === noteId)).toMatchObject({
      readerTarget: null,
    });
    const source = await searchCase(root, slug, { q: '合成測試正文' });
    expect(source.ok && source.data.hits.find((hit) => hit.id === itemId)).toMatchObject({
      readerTarget: { itemId, noteId: null },
    });
  });
  it('附件排在一般點註前、讀回原檔名，並拒絕繞過畫面的編輯請求', async () => {
    // 正文是解析過的 Markdown：「來源\n\n合成測試正文。」（ADR-0039），選「合成測試」。
    const ordinary = await createNote(root, slug, itemId, { body: '手寫點註', start: 4, end: 8 });
    expect(ordinary.ok).toBe(true);
    const file = await attach('# 附件\n保留原文', '原始檔名.md');
    const listed = await listNotesForItem(root, slug, itemId);
    expect(listed.ok && listed.data[0]).toMatchObject({
      fileName: '原始檔名.md',
      note: { id: file.id },
    });
    const changed = await app.inject({
      method: 'PATCH',
      url: `/api/cases/${slug}/notes/${file.id}`,
      payload: { body: '不准覆寫' },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ code: 'NOTE_FILE_READ_ONLY' });
    expect(await readFile(file.mdPath!, 'utf8')).toBe('# 附件\n保留原文');
    if (!ordinary.ok) throw new Error('ordinary note failed');
    expect((await updateNote(root, slug, ordinary.data.note.note.id, '仍可改')).ok).toBe(true);
    await rm(join(folder, 'notes', `${file.id}.filename.json`));
    const withoutMetadata = await listNotesForItem(root, slug, itemId);
    expect(withoutMetadata.ok && withoutMetadata.data[0]).toMatchObject({
      fileName: null,
      note: { body: '# 附件\n保留原文' },
    });
  });

  it('主伺服器拒絕外站、超限及不合法 UTF-8，且不留下筆記', async () => {
    const url = `/api/cases/${slug}/items/${itemId}/note-files`;
    const headers = { 'content-type': 'application/octet-stream', 'x-file-name': 'x.md' };
    const foreign = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, origin: 'https://foreign.example' },
      payload: Buffer.from('note'),
    });
    expect(foreign.statusCode).toBe(403);
    const large = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: Buffer.alloc(1048577, 97),
    });
    expect(large.statusCode).toBe(413);
    expect(large.json()).toMatchObject({ code: 'NOTE_FILE_TOO_LARGE' });
    const invalid = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: Buffer.from([0xff]),
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'NOTE_FILE_UNSUPPORTED' });
    const extension = await upload('valid UTF-8', 'not-markdown.txt');
    expect(extension.statusCode).toBe(400);
    expect(extension.json()).toMatchObject({ code: 'NOTE_FILE_UNSUPPORTED' });
    expect(db.prepare('SELECT count(*) AS n FROM note').get()).toMatchObject({ n: 0 });
  });

  it('複本無法建立時不寫入任何筆記或關聯', async () => {
    const directory = join(folder, 'notes');
    await rmdir(directory);
    await writeFile(directory, 'synthetic obstruction');
    expect((await upload('writefailure')).json()).toMatchObject({
      ok: false,
      code: 'NOTE_UNEXPECTED',
    });
    expect(db.prepare('SELECT count(*) AS n FROM note').get()).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM edge').get()).toMatchObject({ n: 0 });
  });

  it('移除 BOM，保存全文、原檔名、首個 H1，建立可搜尋的人工已確認關聯', async () => {
    const body = '前言\r\n# 附件標題\r\nneedleattachment 獨特內容\r\n# 第二標題';
    expect(db.prepare('SELECT kind FROM item WHERE id = ?').get(itemId)).toMatchObject({
      kind: 'text',
    });
    const note = await attach(`\uFEFF${body}`);
    expect(note).toMatchObject({ body, selectorJson: '[]', anchorOk: true, itemId });
    expect(note.mdPath).toBe(join(folder, 'notes', `${note.id}.md`));
    expect(await readFile(note.mdPath!, 'utf8')).toBe(body);
    expect(
      JSON.parse(await readFile(join(folder, 'notes', `${note.id}.filename.json`), 'utf8')),
    ).toEqual({ fileName: '研究筆記.md' });
    expect(db.prepare('SELECT kind, title FROM item WHERE id = ?').get(note.id)).toMatchObject({
      kind: 'note',
      title: '附件標題',
    });
    expect(
      db
        .prepare('SELECT layer, rel, origin, status, target_id FROM edge WHERE source_id = ?')
        .get(note.id),
    ).toMatchObject({
      layer: 'named',
      rel: '註於',
      origin: 'human',
      status: 'confirmed',
      target_id: itemId,
    });
    const found = await searchCase(root, slug, { q: 'needleattachment', mode: 'text' });
    expect(found.ok && found.data.hits.some((hit) => hit.id === note.id)).toBe(true);
    expect(found.ok && found.data.hits.find((hit) => hit.id === note.id)).toMatchObject({
      readerTarget: { itemId, noteId: note.id },
    });
    expect((await rebuildDerived(root, slug)).ok).toBe(true);
    const listed = await listNotesForItem(root, slug, itemId);
    expect(listed.ok && listed.data[0]?.hit.kind).toBe('exact');
  });

  it('沒有 H1 時用檔名，每次重附新增一則，刪除清除複本、索引與關聯', async () => {
    const a = await attach('uniqueattachmentword', '沒有標題.MD');
    const b = await attach('uniqueattachmentword', '沒有標題.MD');
    expect(a.id).not.toBe(b.id);
    expect(db.prepare('SELECT title FROM item WHERE id = ?').get(a.id)).toMatchObject({
      title: '沒有標題',
    });
    expect((await deleteNote(root, slug, a.id)).ok).toBe(true);
    expect(await readdir(join(folder, 'notes'))).not.toContain(`${a.id}.md`);
    expect(await readdir(join(folder, 'notes'))).not.toContain(`${a.id}.filename.json`);
    expect(db.prepare('SELECT id FROM edge WHERE source_id = ?').get(a.id)).toBeUndefined();
    const found = await searchCase(root, slug, { q: 'uniqueattachmentword', mode: 'text' });
    expect(found.ok && found.data.hits.map((hit) => hit.id)).toEqual([b.id]);
  });

  it('只移除一個 BOM，保留正文中的第二個 U+FEFF', async () => {
    const note = await attach('\uFEFF\uFEFF正文');
    expect(note.body).toBe('\uFEFF正文');
  });

  it('書目不需要正文也能附；筆記與不存在的目標不能附', async () => {
    const source = db.prepare('SELECT run_id FROM item WHERE id = ?').get(itemId) as {
      run_id: string;
    };
    itemId = randomUUID();
    insertReference(db, {
      id: itemId,
      title: '沒有快照的書目',
      url: 'https://example.org/reference',
      bibJson: '{}',
      runId: source.run_id,
      now: Date.now(),
    });
    const note = await attach('書目筆記');
    expect((await upload('不可巢狀', 'x.md', note.id)).json()).toMatchObject({
      ok: false,
      code: 'NOTE_TARGET_MISSING',
    });
    expect((await upload('不存在', 'x.md', 'missing')).json()).toMatchObject({
      ok: false,
      code: 'GRAPH_NODE_NOT_FOUND',
    });
    expect(db.prepare('SELECT count(*) AS n FROM note').get()).toMatchObject({ n: 1 });
  });

  it('建立關聯失敗時回滾筆記與索引，並移除本次檔案', async () => {
    db.exec(
      "CREATE TRIGGER fail_attachment BEFORE INSERT ON edge BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END",
    );
    expect((await upload('rollbackattachment')).json()).toMatchObject({
      ok: false,
      code: 'NOTE_UNEXPECTED',
    });
    expect(db.prepare('SELECT count(*) AS n FROM note').get()).toMatchObject({ n: 0 });
    expect(db.prepare("SELECT count(*) AS n FROM item WHERE kind = 'note'").get()).toMatchObject({
      n: 0,
    });
    expect(await readdir(join(folder, 'notes'))).toEqual([]);
    const found = await searchCase(root, slug, { q: 'rollbackattachment', mode: 'text' });
    expect(found.ok && found.data.hits).toEqual([]);
  });
});
