/**
 * 端對端：**線上 chat 端點**（Stage 16）。
 *
 * 走的是設定頁實際會走的整條路：`POST /api/providers` 存設定 →
 * `GET /api/providers` 讀狀態 → `POST /api/providers/test` 實際打一次。
 *
 * ## 為什麼一定要有這一條
 *
 * 2026-09-10 server 把 `chatReadiness` 改名成 `taskReadiness`，
 * **762 個測試全過、`tsc` 與 `vue-tsc` 也全過**，而設定頁在執行時拿到 `undefined` ——
 * `web/` 是另一份型別宣告，沒有任何測試讀過那個欄位。
 * 這一輪加了四個新欄位（`transport`、`jsonMode`、`embedModels`、`chatTasks[].jsonMode`），
 * **只有一條真的打過端點的測試能證明它們真的在回應裡。**
 *
 * ## 兩個假端點
 *
 * 一個假的 OpenAI 相容端點（chat），一個假的本機 Ollama（embed）——
 * 那是 Stage 16 拆開的那個耦合：chat 換成線上端點之後，嵌入的清單與探測
 * **必須還是問本機那一個**。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildServer } from '../../src/server.js';

const KEY_ENV = 'CYCLOSA_E2E_ONLINE_KEY';
const KEY = 'sk-e2e-online-0123456789abcdef';

let sandbox: string;
let localAppData: string;
let app: FastifyInstance;
let online: Server;
let ollama: Server;
let onlineBase: string;
let ollamaBase: string;
let saved: { local?: string | undefined; key?: string | undefined };
let completions: number;
let schemaSupported: boolean;

function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  if (a === null || typeof a === 'string') throw new Error('no port');
  return a.port;
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-online-'));
  localAppData = join(sandbox, 'LocalAppData');
  await mkdir(join(localAppData, 'Cyclosa'), { recursive: true });
  saved = { local: process.env['LOCALAPPDATA'], key: process.env[KEY_ENV] };
  process.env['LOCALAPPDATA'] = localAppData;
  process.env[KEY_ENV] = KEY;
  completions = 0;
  schemaSupported = true;

  online = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').replace(/^\/v1/, '');
      const body = await bodyOf(req);
      const json = (status: number, v: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(v));
      };
      if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: 'bad key' });
      if (path === '/models') {
        return json(200, { data: [{ id: 'online-large', context_length: 200000 }] });
      }
      if (path === '/chat/completions') {
        completions++;
        const fmt = (body['response_format'] as { type?: string } | undefined)?.type;
        const text = JSON.stringify(body['messages']);
        if (fmt === 'json_schema' && !schemaSupported)
          return json(400, { error: 'response_format' });
        const content = text.includes('介紹你自己')
          ? JSON.stringify({ probe: 'cyclosa-json-schema-probe', n: 7 })
          : JSON.stringify({ ok: true });
        return json(200, { choices: [{ message: { content }, finish_reason: 'stop' }] });
      }
      json(404, {});
    })();
  });
  ollama = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    if ((req.url ?? '') === '/api/tags') {
      res.end(JSON.stringify({ models: [{ name: 'qwen3-embedding:4b' }] }));
    } else res.end('{}');
  });
  onlineBase = `http://127.0.0.1:${await listen(online)}/v1`;
  ollamaBase = `http://127.0.0.1:${await listen(ollama)}`;

  const built = await buildServer();
  app = built.app;
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await new Promise<void>((r) => online.close(() => r()));
  await new Promise<void>((r) => ollama.close(() => r()));
  if (saved.local === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved.local;
  if (saved.key === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = saved.key;
  await rm(sandbox, { recursive: true, force: true });
});

interface Status {
  role: string;
  state: string;
  transport: string | null;
  jsonMode: { mode: string; checkedAt: number | null } | null;
  auth: string;
}
interface Payload {
  statuses: Status[];
  chatModels: string[] | null;
  embedModels: string[] | null;
  chatTasks: { task: string; jsonMode: { mode: string } | null }[];
  config: { chat: { transport: string; apiKeyEnv: string | null } | null };
}

async function saveOnline(): Promise<Payload> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/providers',
    payload: {
      version: 1,
      chat: {
        transport: 'openai',
        baseUrl: onlineBase,
        model: 'online-large',
        apiKeyEnv: KEY_ENV,
        taskModels: { angles: '', extract: '' },
      },
      agent: null,
      embed: { baseUrl: ollamaBase, model: 'qwen3-embedding:4b' },
    },
  });
  const body = res.json() as { ok: boolean; data: Payload };
  expect(body.ok, JSON.stringify(body)).toBe(true);
  return body.data;
}

const chatStatus = (p: Payload): Status => p.statuses.find((s) => s.role === 'chat') as Status;

describe('線上 chat 端點', () => {
  it('存得進去，讀回來是 openai，而且設定檔裡存的是變數名不是金鑰', async () => {
    const p = await saveOnline();
    expect(p.config.chat?.transport).toBe('openai');
    expect(p.config.chat?.apiKeyEnv).toBe(KEY_ENV);
    const file = await readFile(join(localAppData, 'Cyclosa', 'providers.json'), 'utf8');
    expect(file).toContain(KEY_ENV);
    expect(file).not.toContain(KEY);
  });

  it('模型清單來自線上端點的 /models，狀態是就緒、金鑰偵測到', async () => {
    const p = await saveOnline();
    expect(p.chatModels).toEqual(['online-large']);
    const chat = chatStatus(p);
    expect(chat.state).toBe('ready');
    expect(chat.transport).toBe('openai');
    expect(chat.auth).toBe('env-set');
  });

  /**
   * **Stage 16 拆開的那個耦合。** 在那之前嵌入的清單就是 chat 的清單 ——
   * chat 換成線上端點，嵌入的下拉就會列出 `online-large`，
   * 而嵌入的探測會去線上清單裡找一個本機模型。
   */
  it('嵌入的清單與狀態還是問本機 Ollama，不跟著 chat 走', async () => {
    const p = await saveOnline();
    expect(p.embedModels).toEqual(['qwen3-embedding:4b']);
    expect(p.statuses.find((s) => s.role === 'embed')?.state).toBe('ready');
  });

  it('打開設定頁不送任何一次對話請求，格式保證顯示「還沒量」', async () => {
    const p = await saveOnline();
    expect(completions).toBe(0);
    expect(chatStatus(p).jsonMode?.mode).toBe('unchecked');
    expect(p.chatTasks.every((row) => row.jsonMode?.mode === 'unchecked')).toBe(true);
  });

  it('按「實際打一次」會量格式支援，而且量到的結果留在狀態裡、帶著時間', async () => {
    await saveOnline();
    const res = await app.inject({
      method: 'POST',
      url: '/api/providers/test',
      payload: { role: 'chat' },
    });
    const test = (res.json() as { data: { ok: boolean; jsonMode: { mode: string } } }).data;
    expect(test.ok).toBe(true);
    expect(test.jsonMode.mode).toBe('schema');

    const again = (
      (await app.inject({ method: 'GET', url: '/api/providers' })).json() as { data: Payload }
    ).data;
    expect(chatStatus(again).jsonMode?.mode).toBe('schema');
    expect(chatStatus(again).jsonMode?.checkedAt).toBeGreaterThan(0);
  });

  it('端點只收 json_object 時量出 object —— 降級了，而且狀態說得出來', async () => {
    schemaSupported = false;
    await saveOnline();
    await app.inject({ method: 'POST', url: '/api/providers/test', payload: { role: 'chat' } });
    const p = (
      (await app.inject({ method: 'GET', url: '/api/providers' })).json() as { data: Payload }
    ).data;
    expect(chatStatus(p).jsonMode?.mode).toBe('object');
    // 事後檢查也算保證了形狀，所以閘門不擋 —— **擋的是 none，而 object 是說出來的降級**
    expect(chatStatus(p).state).toBe('ready');
  });

  it('環境變數沒設的時候，狀態說得出「設了名字但讀不到」', async () => {
    delete process.env[KEY_ENV];
    const p = await saveOnline();
    expect(chatStatus(p).auth).toBe('env-missing');
    expect(chatStatus(p).state).toBe('unreachable');
  });
});
