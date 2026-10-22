/**
 * 路徑參數不得帶出資料夾（ADR-0038）。判斷本身逐條驗，再驗它**真的掛在 `buildServer()` 上**：
 * `%2F` 在路由比對之後才被解碼成 `/`，所以這種請求確實會比對到 `/api/cases/:slug/...`。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { isSafeSegment, paramVerdict } from '../../src/interface/http/param-guard.js';
import { buildServer } from '../../src/server.js';

describe('paramVerdict', () => {
  it.each([
    [{ slug: '蓬萊塵蛛' }, 'ok'],
    [{ slug: 'my-case', itemId: '3f2b6c1e-0000-4000-8000-000000000000' }, 'ok'],
    [{ slug: '../../x' }, 'bad-slug'],
    [{ slug: '..' }, 'bad-slug'],
    [{ slug: 'a\\b' }, 'bad-slug'],
    [{ slug: 'ok', itemId: '../../secret' }, 'bad-segment'],
    [{ slug: 'ok', noteId: '..' }, 'bad-segment'],
    [{ slug: 'ok', runId: 'a\0b' }, 'bad-segment'],
  ])('%j → %s', (params, verdict) => {
    expect(paramVerdict(params)).toBe(verdict);
  });

  it('只擋路徑字元，不驗 id 的格式', () => {
    expect(isSafeSegment('01HZX-not-a-uuid')).toBe(true);
    expect(isSafeSegment('')).toBe(false);
  });
});

describe('掛在 buildServer 上', () => {
  let sandbox: string;
  let app: FastifyInstance;
  let saved: string | undefined;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-param-'));
    const localAppData = join(sandbox, 'LocalAppData');
    await mkdir(localAppData, { recursive: true });
    saved = process.env['LOCALAPPDATA'];
    process.env['LOCALAPPDATA'] = localAppData;
    app = (await buildServer()).app;
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
    if (saved === undefined) delete process.env['LOCALAPPDATA'];
    else process.env['LOCALAPPDATA'] = saved;
    await rm(sandbox, { recursive: true, force: true });
  });

  it('編碼過的 ../ 在進路由之前就被擋下', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/cases/..%2F..%2Fsomewhere/runs',
      headers: { host: '127.0.0.1:7433' },
    });
    expect(res.statusCode).toBe(404);
    // service 對不存在的專題也回 CASE_NOT_FOUND —— 只有 `bad-slug` 證明是守門擋的
    expect(res.json()).toMatchObject({
      ok: false,
      code: 'CASE_NOT_FOUND',
      correlationId: 'bad-slug',
    });
  });
});
