import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_NOTE_FILE_BYTES, parseNoteFile } from '../../src/application/note-file-input.js';
import { registerNoteFileRoute } from '../../src/interface/http/note-file-route.js';
import { err, ok } from '../../src/shared/result.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setup() {
  const app = Fastify();
  apps.push(app);
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) =>
    done(null, body),
  );
  const attach = vi.fn(async () => ok({ id: 'synthetic-note' }, 'test'));
  registerNoteFileRoute(app, attach);
  return { app, attach };
}

const url = '/api/cases/example/items/item-1/note-files';
const headers = {
  'content-type': 'application/octet-stream',
  'x-file-name': encodeURIComponent('合成筆記.md'),
};

describe('筆記檔接收層（儲存服務尚未接上）', () => {
  it.each([false, true])('接受繁中 UTF-8，BOM=%s，原樣交給服務', async (bom) => {
    const { app, attach } = setup();
    const body = '# 合成筆記\r\n測試正文\n';
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: Buffer.from((bom ? '\uFEFF' : '') + body),
    });
    expect(response.statusCode).toBe(200);
    expect(attach).toHaveBeenCalledExactlyOnceWith(
      { slug: 'example', itemId: 'item-1' },
      { fileName: '合成筆記.md', body },
    );
    expect(response.json()).toEqual(ok({ id: 'synthetic-note' }, 'test'));
  });

  it('恰好 1 MB 可收，超過一 byte 回指定碼且不呼叫服務', async () => {
    const { app, attach } = setup();
    const accepted = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: Buffer.alloc(MAX_NOTE_FILE_BYTES, 65),
    });
    expect(accepted.statusCode).toBe(200);
    attach.mockClear();
    const rejected = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: Buffer.alloc(MAX_NOTE_FILE_BYTES + 1, 65),
    });
    expect(rejected.statusCode).toBe(413);
    expect(rejected.json()).toMatchObject({
      ok: false,
      code: 'NOTE_FILE_TOO_LARGE',
      correlationId: expect.any(String),
    });
    expect(attach).not.toHaveBeenCalled();
  });

  it('串流未宣告 Content-Length 仍受上限保護', async () => {
    const { app, attach } = setup();
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: Readable.from([Buffer.alloc(MAX_NOTE_FILE_BYTES, 65), Buffer.from('x')]),
    });
    expect(response.statusCode).toBe(413);
    expect(response.json().code).toBe('NOTE_FILE_TOO_LARGE');
    expect(attach).not.toHaveBeenCalled();
  });

  it.each([
    'test.txt',
    '',
    '%ZZ',
    encodeURIComponent('../test.md'),
    encodeURIComponent('C:\\test.md'),
  ])('拒絕不合法檔名 %s', async (name) => {
    const { app, attach } = setup();
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'x-file-name': name },
      payload: Buffer.from('test'),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('NOTE_FILE_UNSUPPORTED');
    expect(attach).not.toHaveBeenCalled();
  });

  it.each([
    [0xc3, 0x28],
    [0xff, 0xfe, 65, 0],
    [0xe4, 0xb8],
  ])('拒絕無效 UTF-8 %j', async (...bytes) => {
    const { app, attach } = setup();
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: Buffer.from(bytes),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('NOTE_FILE_UNSUPPORTED');
    expect(attach).not.toHaveBeenCalled();
  });

  it('不接受用 JSON 代替檔案位元組', async () => {
    const { app, attach } = setup();
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { body: 'text' },
    });
    expect(response.statusCode).toBe(400);
    expect(attach).not.toHaveBeenCalled();
  });

  it('保留服務失敗，不回假成功', async () => {
    const app = Fastify();
    apps.push(app);
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer' },
      (_req, body, done) => done(null, body),
    );
    registerNoteFileRoute(app, async () => err('GRAPH_NODE_NOT_FOUND', 'test'));
    const response = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: Buffer.from('text'),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(err('GRAPH_NODE_NOT_FOUND', 'test'));
  });

  it('直接呼叫解析器也遵守位元組上限，BOM 計入大小', () => {
    const bytes = Buffer.concat([Buffer.from('\uFEFF'), Buffer.alloc(MAX_NOTE_FILE_BYTES - 2, 65)]);
    expect(parseNoteFile('test.md', bytes)).toMatchObject({
      ok: false,
      code: 'NOTE_FILE_TOO_LARGE',
    });
    expect(parseNoteFile('test.MD', Buffer.from(''))).toMatchObject({
      ok: true,
      data: { body: '' },
    });
  });
});
