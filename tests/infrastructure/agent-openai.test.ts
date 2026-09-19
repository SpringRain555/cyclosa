/**
 * OpenAI 相容 API 當找來源的 agent（`agent-openai.ts`，ADR-0034）—— 對著一個行為可以設定的假端點。
 *
 * ## 真的量過一次，而假端點演的是另外幾種
 *
 * 2026-09-19 對使用者那一條端點（Codex 訂閱的代理）量過：`/responses` 帶 `web_search` 真的搜尋、
 * 同時照 json_schema 交出候選。但這支程式要處理的是它**沒照做**的幾種：收了工具沒搜尋、
 * 搜了但交回的形狀不對、根本沒有 `/responses`、直接拒絕 —— 那些在真的端點上演不出來。
 *
 * ## 「會搜尋」的判準
 *
 * 只有**回應裡有一筆完成的 `web_search_call`、而且交回的 JSON 符合 schema**才算會。
 * 一個回 200、沒報錯、卻沒搜尋的端點，正是要擋的那一種 —— 它給的網址只可能來自記憶。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { missingFor, TASK_FIND_SOURCES } from '../../src/domain/provider/index.js';
import { createOpenAiAgent } from '../../src/infrastructure/providers/agent-openai.js';
import {
  checksFilePath,
  readBrowseChecks,
  readJsonChecks,
  writeJsonCheck,
} from '../../src/infrastructure/providers/json-checks.js';
import { parseResponsesBody } from '../../src/infrastructure/providers/responses-api.js';

const KEY_ENV = 'CYCLOSA_TEST_KEY';
const KEY = 'sk-test-0123456789abcdefDEADBEEF';

const SOURCES_SCHEMA = {
  type: 'object',
  properties: {
    candidates: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: { url: { type: 'string' }, why: { type: 'string' } },
        required: ['url', 'why'],
      },
    },
  },
  required: ['candidates'],
} as const;

type Mode =
  /** 搜了、交回的形狀對 —— 真的端點 2026-09-19 的樣子 */
  | 'search'
  /** 收了工具，沒搜尋就回答 */
  | 'no-search'
  /** 搜了，但交回的不是 schema 的形狀 */
  | 'bad-shape'
  /** 端點不理會 `stream`，回一整份 JSON */
  | 'json-body'
  /** 沒有 `/responses` */
  | 'missing'
  /** 收到帶工具的請求直接 400（回顯標頭） */
  | 'rejected'
  | 'auth'
  /** 串流說沒完成 */
  | 'incomplete'
  /** 串流說失敗 */
  | 'failed';

let server: Server;
let base: string;
let sandbox: string;
let env: NodeJS.ProcessEnv;
let mode: Mode;
let rateLimitFirst: number;
let seen: { path: string; headers: IncomingMessage['headers']; body: Record<string, unknown> }[];

function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () =>
      resolve(raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {}),
    );
  });
}

function sse(events: readonly Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

/** 一段串流：可選一筆搜尋、一則訊息、一個收尾。**`response.completed` 的 output 刻意是空的。** */
function stream(opts: {
  search: boolean;
  text: string;
  end?: 'completed' | 'incomplete' | 'failed';
}): string {
  const events: Record<string, unknown>[] = [
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.output_item.done', item: { type: 'reasoning', summary: [] } },
  ];
  if (opts.search) {
    events.push(
      { type: 'response.web_search_call.searching', item_id: 'ws_1' },
      {
        type: 'response.output_item.done',
        item: {
          type: 'web_search_call',
          status: 'completed',
          action: { type: 'search', queries: ['site:o-ran.org WG11', 'O-RAN security'] },
        },
      },
    );
  }
  events.push(
    { type: 'response.output_text.delta', delta: opts.text },
    {
      type: 'response.output_item.done',
      item: { type: 'message', content: [{ type: 'output_text', text: opts.text }] },
    },
  );
  const end = opts.end ?? 'completed';
  if (end === 'completed') {
    events.push({ type: 'response.completed', response: { status: 'completed', output: [] } });
  } else if (end === 'incomplete') {
    events.push({
      type: 'response.incomplete',
      response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
    });
  } else {
    events.push({
      type: 'response.failed',
      response: { status: 'failed', error: { message: 'upstream exploded' } },
    });
  }
  return sse(events);
}

const GOOD = JSON.stringify({
  candidates: [{ url: 'https://www.o-ran.org/technical-groups/wg11', why: '官方頁' }],
});
const PROBE_GOOD = JSON.stringify({ url: 'https://nodejs.org/en/download' });

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-openai-agent-'));
  env = { LOCALAPPDATA: sandbox, [KEY_ENV]: KEY };
  seen = [];
  mode = 'search';
  rateLimitFirst = 0;

  server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').replace(/^\/v1/, '');
      const body = await bodyOf(req);
      seen.push({ path, headers: req.headers, body });
      const send = (status: number, text: string, extra: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...extra });
        res.end(text);
      };
      if (path === '/models') {
        return send(200, JSON.stringify({ data: [{ id: 'm1', context_length: 400000 }] }));
      }
      if (path !== '/responses') return send(404, 'nope');
      if (rateLimitFirst > 0) {
        rateLimitFirst -= 1;
        return send(429, '{"error":"slow down"}', { 'retry-after': '0' });
      }
      // 量測那一題要的是一個網址；正式那一題要的是候選清單。看 schema 的名字分。
      const name = (body['text'] as { format: { name: string } }).format.name;
      const good = name === 'cyclosa_browse_probe' ? PROBE_GOOD : GOOD;
      const out = (text: string): void => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(text);
      };
      switch (mode) {
        case 'missing':
          return send(404, '{"error":"unknown route"}');
        case 'auth':
          return send(401, '{"error":"bad key"}');
        case 'rejected':
          return send(
            400,
            `{"error":"tools not supported" auth=${req.headers.authorization ?? ''}}`,
          );
        case 'json-body':
          return send(
            200,
            JSON.stringify({
              status: 'completed',
              output: [
                { type: 'web_search_call', status: 'completed', action: { query: 'q' } },
                { type: 'message', content: [{ type: 'output_text', text: good }] },
              ],
            }),
          );
        case 'no-search':
          return out(stream({ search: false, text: good }));
        case 'bad-shape':
          return out(stream({ search: true, text: JSON.stringify({ nope: 1 }) }));
        case 'incomplete':
          return out(stream({ search: true, text: '', end: 'incomplete' }));
        case 'failed':
          return out(stream({ search: true, text: '', end: 'failed' }));
        default:
          return out(stream({ search: true, text: good }));
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  base = `http://127.0.0.1:${address.port}/v1`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(sandbox, { recursive: true, force: true });
});

function agent(model = 'm1') {
  return createOpenAiAgent({
    baseUrl: base,
    model,
    apiKeyEnv: KEY_ENV,
    schema: SOURCES_SCHEMA,
    systemPrompt: '找候選來源。',
    env,
  });
}
const calls = (): number => seen.filter((s) => s.path === '/responses').length;
const run = () => agent().run({ prompt: '主題', cwd: sandbox, timeoutMs: 10_000 });

// ── 探測 ──────────────────────────────────────────────────────

describe('探測', () => {
  it('就緒；還沒量的時候 browse 放行（開始擴展之前會量）', async () => {
    const p = await agent().probe();
    expect(p.kind).toBe('ready');
    if (p.kind === 'ready') {
      expect(p.capabilities.browse).toBe(true);
      expect(p.capabilities.context_tokens).toBe(400000);
      expect(missingFor(TASK_FIND_SOURCES, p.capabilities).kind).toBe('ok');
    }
    expect(calls()).toBe(0);
  });

  it('清單上沒有的模型 ＝ 沒設定', async () => {
    expect((await agent('nope').probe()).kind).toBe('not-configured');
  });

  it('量出不會搜尋之後，browse 是 false，配對說缺「browse」', async () => {
    mode = 'no-search';
    await agent().checkBrowse!();
    const p = await agent().probe();
    if (p.kind !== 'ready') expect.fail(p.kind);
    expect(p.capabilities.browse).toBe(false);
    const m = missingFor(TASK_FIND_SOURCES, p.capabilities);
    expect(m.kind === 'missing' && m.flags).toEqual(['browse']);
  });
});

// ── 量「會不會搜尋」 ───────────────────────────────────────────

describe('checkBrowse', () => {
  it('真的搜尋了、形狀對 → yes，帶著時間記下來，而且不洗掉 JSON 那一種的紀錄', async () => {
    // 先放一筆 JSON 格式的量測：兩種共用一個檔，寫一種不能把另一種洗掉。
    await writeJsonCheck(
      base,
      'm1',
      { mode: 'schema', checkedAt: 5, detail: 'json_schema', protocol: 'responses' },
      env,
    );
    const before = Date.now();
    const r = await agent().checkBrowse!();
    expect(r.kind === 'ok' && r.value.state).toBe('yes');
    if (r.kind === 'ok') {
      expect(r.value.checkedAt).toBeGreaterThanOrEqual(before);
      expect(r.value.detail).toContain('搜尋了 1 次');
    }
    expect((await readBrowseChecks(env)).size).toBe(1);
    expect((await readJsonChecks(env)).size).toBe(1);
    // 量測那一次也是「一定要搜」、只給一個工具。
    const sent = seen.at(-1)?.body ?? {};
    expect(sent['tools']).toEqual([{ type: 'web_search' }]);
    expect(sent['tool_choice']).toBe('required');
    expect(sent['stream']).toBe(true);
    expect(seen.at(-1)?.headers.accept).toBe('text/event-stream');
    expect(seen.at(-1)?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('收了工具卻沒搜尋 → no，說出原因', async () => {
    mode = 'no-search';
    const r = await agent().checkBrowse!();
    expect(r.kind === 'ok' && r.value.state).toBe('no');
    if (r.kind === 'ok') expect(r.value.detail).toContain('沒有真的搜尋');
  });

  it('搜了但交回的形狀不對 → no', async () => {
    mode = 'bad-shape';
    const r = await agent().checkBrowse!();
    expect(r.kind === 'ok' && r.value.state).toBe('no');
    if (r.kind === 'ok') expect(r.value.detail).toContain('不是指定的格式');
  });

  it('沒有 /responses → no，說出是這條路不存在', async () => {
    mode = 'missing';
    const r = await agent().checkBrowse!();
    expect(r.kind === 'ok' && r.value.state).toBe('no');
    if (r.kind === 'ok') expect(r.value.detail).toContain('/responses');
  });

  it('被拒（400）→ no；回顯的標頭裡的金鑰在 detail 與量測檔裡都被遮掉', async () => {
    mode = 'rejected';
    const r = await agent().checkBrowse!();
    expect(r.kind === 'ok' && r.value.state).toBe('no');
    if (r.kind === 'ok') {
      expect(r.value.detail).not.toContain(KEY);
      expect(r.value.detail).toContain('***');
    }
    expect(await readFile(checksFilePath(env), 'utf8')).not.toContain(KEY);
  });

  /** 量不出來的時候什麼都不記 —— 一把打錯的金鑰不該變成永久的「這個端點不會搜尋」。 */
  it.each([
    ['auth', 'PROVIDER_AUTH_REJECTED'],
    ['incomplete', 'PROVIDER_OUTPUT_UNPARSEABLE'],
    ['failed', 'PROVIDER_UNEXPECTED'],
  ] as const)('%s → %s，不記任何結果', async (m, code) => {
    mode = m;
    const r = await agent().checkBrowse!();
    expect(r.kind === 'error' && r.code).toBe(code);
    expect((await readBrowseChecks(env)).size).toBe(0);
  });

  it('端點不理會 stream、回一整份 JSON 也讀得懂', async () => {
    mode = 'json-body';
    const r = await agent().checkBrowse!();
    expect(r.kind === 'ok' && r.value.state).toBe('yes');
  });

  it('429 一次之後就好了 → 兩個請求', async () => {
    rateLimitFirst = 1;
    const r = await agent().checkBrowse!();
    expect(r.kind === 'ok' && r.value.state).toBe('yes');
    expect(calls()).toBe(2);
  });

  it('browseReport 只讀，不打網路', async () => {
    expect((await agent().browseReport!()).state).toBe('unchecked');
    expect(calls()).toBe(0);
  });
});

// ── 正式呼叫 ───────────────────────────────────────────────────

describe('run()', () => {
  it('送系統提示、題目、只有 web_search 一個工具、一定要搜、json_schema；回的是 JSON 字串', async () => {
    const r = await run();
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(JSON.parse(r.value)).toEqual(JSON.parse(GOOD));
    const sent = seen.at(-1)?.body ?? {};
    expect(sent['instructions']).toBe('找候選來源。');
    expect(sent['input']).toBe('主題');
    expect(sent['tools']).toEqual([{ type: 'web_search' }]);
    expect(sent['tool_choice']).toBe('required');
    const format = (sent['text'] as { format: Record<string, unknown> }).format;
    expect(format['type']).toBe('json_schema');
    expect(format['strict']).toBe(true);
    // 嚴格模式要求的 additionalProperties 是在邊界上補的
    expect((format['schema'] as Record<string, unknown>)['additionalProperties']).toBe(false);
    expect(r.cost.costUsd).toBeNull();
  });

  it('沒搜尋就交回網址 → 不採用（PROVIDER_CAPABILITY_MISSING）', async () => {
    mode = 'no-search';
    const r = await run();
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_CAPABILITY_MISSING');
    if (r.kind === 'error') expect(r.detail).toContain('沒有搜尋');
  });

  it('形狀不對 → SCHEMA_MISMATCH，不是 ok', async () => {
    mode = 'bad-shape';
    const r = await run();
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_OUTPUT_SCHEMA_MISMATCH');
  });

  it('量過不會搜尋 → 停手，而且一個請求都不送', async () => {
    mode = 'no-search';
    await agent().checkBrowse!();
    const n = calls();
    mode = 'search';
    const r = await run();
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_CAPABILITY_MISSING');
    if (r.kind === 'error') expect(r.detail).toContain('量過');
    expect(calls()).toBe(n);
  });

  it('沒有 /responses → 說出是這個端點沒有 Responses API', async () => {
    mode = 'missing';
    const r = await run();
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_CAPABILITY_MISSING');
    if (r.kind === 'error') expect(r.detail).toContain('Responses API');
  });

  it('金鑰被拒要說是被拒，不是連不上', async () => {
    mode = 'auth';
    const r = await run();
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_AUTH_REJECTED');
  });

  it('串流說沒完成 → 說得出理由', async () => {
    mode = 'incomplete';
    const r = await run();
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_OUTPUT_UNPARSEABLE');
    if (r.kind === 'error') expect(r.detail).toContain('max_output_tokens');
  });
});

// ── 讀回應 ─────────────────────────────────────────────────────

describe('parseResponsesBody', () => {
  it('串流：文字以 output_item.done 的 message 為準，搜尋次數與查詢字串都讀得到', () => {
    const a = parseResponsesBody(stream({ search: true, text: '{"a":1}' }));
    expect(a.status).toBe('completed');
    expect(a.text).toBe('{"a":1}');
    expect(a.searches).toBe(1);
    expect(a.queries).toEqual(['site:o-ran.org WG11', 'O-RAN security']);
  });

  it('串流沒有 message 項目時，退而用 delta 拼起來', () => {
    const raw = sse([
      { type: 'response.output_text.delta', delta: '{"a"' },
      { type: 'response.output_text.delta', delta: ':1}' },
      { type: 'response.completed', response: { output: [] } },
    ]);
    expect(parseResponsesBody(raw).text).toBe('{"a":1}');
  });

  it('沒有收尾事件 ＝ unfinished；壞掉的事件行跳過', () => {
    const raw = `data: {not json\n\n${sse([{ type: 'response.output_text.delta', delta: 'x' }])}`;
    const a = parseResponsesBody(raw);
    expect(a.status).toBe('unfinished');
    expect(a.text).toBe('x');
  });

  it('error 事件 ＝ failed，理由帶出來', () => {
    const raw = sse([{ type: 'error', message: 'boom' }]);
    const a = parseResponsesBody(raw);
    expect(a.status).toBe('failed');
    expect(a.reason).toBe('boom');
  });

  it('一整份 JSON：status、output、incomplete_details 都讀', () => {
    const a = parseResponsesBody(
      JSON.stringify({
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [
          { type: 'web_search_call', status: 'in_progress', action: { query: 'q' } },
          { type: 'message', content: [{ type: 'output_text', text: 'partial' }] },
        ],
      }),
    );
    expect(a.status).toBe('incomplete');
    expect(a.reason).toBe('max_output_tokens');
    // 沒完成的搜尋不算
    expect(a.searches).toBe(0);
    expect(a.text).toBe('partial');
  });

  it('不是 JSON 也不是 SSE 的東西 ＝ unfinished，不丟例外', () => {
    expect(parseResponsesBody('<html>nope</html>').status).toBe('unfinished');
    expect(parseResponsesBody('{ broken').status).toBe('unfinished');
  });
});
