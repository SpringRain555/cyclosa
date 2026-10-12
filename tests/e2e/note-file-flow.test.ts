import { mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import { createCase } from '../../src/application/case-service.js';
import { importFile } from '../../src/application/ingest-service.js';
import {
  deleteNote,
  listNotesForItem,
  type CreatedNote,
} from '../../src/application/note-service.js';
import { searchCase } from '../../src/application/search-service.js';
import { rebuildDerived } from '../../src/application/rebuild-service.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
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
    db.prepare("UPDATE item SET kind = 'reference' WHERE id = ?").run(itemId);
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
