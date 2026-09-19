/**
 * OpenAI 相容 API —— 對著一個**行為可以設定**的假端點。
 *
 * ## 為什麼是假端點，而不是量真的
 *
 * 真的量過了：Ollama 0.33.2 的 `/v1`（`docs/research/openai-compat-json-schema.md`）。
 * 但那一個端點只展示得出一種行為（`json_schema` 支援而且真的套用），
 * 而這支程式要處理的是**三種**：真的套用、收了但安靜忽略、直接拒絕。
 * 後兩種在這台機器上沒有一個端點演得出來，所以由這裡演。
 *
 * ## 兩條路（v0.24.2，ADR-0034）
 *
 * 假端點預設**沒有** `/responses`（回 404）：上面那些測試因此走的是 Chat Completions，
 * 跟 v0.24.1 之前一模一樣。最後一組 describe 把 `/responses` 打開，
 * 測「先走 Responses API」那一半：請求的形狀、串流的讀法、量到的協定、舊紀錄怎麼處理。
 *
 * **完全隔離**：`provider-checks.json` 寫在臨時的 `LOCALAPPDATA` 底下，
 * 環境變數用一個傳進去的物件，不動 `process.env`。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createOpenAiChat,
  listOpenAiModels,
} from '../../src/infrastructure/providers/chat-openai.js';
import { checksFilePath, readJsonChecks } from '../../src/infrastructure/providers/json-checks.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const KEY_ENV = 'CYCLOSA_TEST_KEY';
/** 刻意長得像一把真的金鑰 —— 洩漏檢查找的就是它。 */
const KEY = 'sk-test-0123456789abcdefDEADBEEF';

interface Behaviour {
  models: 'ok' | 'auth' | 'missing-v1';
  /** `json_schema` 那一種請求怎麼回 */
  schema: 'enforced' | 'ignored' | 'rejected' | 'auth' | 'rate-limited';
  /** `json_object` 那一種請求回不回物件 */
  object: boolean;
  /** 任務本身（非量測）的那一次回什麼內容 */
  answer: string;
  finish: string;
  /** 錯誤內文要不要把請求標頭回顯出來 —— 有的伺服器真的會 */
  echoHeaders: boolean;
  /** 前幾次 chat 請求先回 429（帶 `Retry-After: 0`），之後照常 —— 演「排隊一下就好」 */
  rateLimitFirst: number;
  /**
   * `/responses` 有沒有、怎麼回（v0.24.2）。`none` ＝ 404（上面那些測試的前提）；
   * 其餘三種跟 `schema` 那一欄同一組意思，但走 Responses API 的形狀（`text.format`、SSE 串流）。
   * `json-body` ＝ 端點不理會 `stream`，回一整份 JSON；`incomplete` ＝ 串流說沒完成。
   */
  responses: 'none' | 'enforced' | 'ignored' | 'rejected' | 'json-body' | 'incomplete';
}

/** 一段 SSE：每個事件一個 `data:` 行。 */
function sse(events: readonly Record<string, unknown>[]): string {
  return events.map((e) => `event: ${String(e['type'])}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}
/** Responses API 的串流：一個 message 項目 ＋ 收尾事件。**`response.completed` 的 output 刻意是空的**（使用者那一條代理就是這樣）。 */
function responsesStream(text: string, end = 'response.completed', reason = ''): string {
  const message = {
    type: 'message',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const closing: Record<string, unknown> =
    end === 'response.completed'
      ? { type: end, response: { status: 'completed', output: [] } }
      : {
          type: end,
          response: { status: 'incomplete', incomplete_details: { reason }, output: [] },
        };
  return sse([
    { type: 'response.created', response: { status: 'in_progress' } },
    { type: 'response.output_item.added', item: { type: 'reasoning' } },
    { type: 'response.output_item.done', item: { type: 'reasoning', summary: [] } },
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.output_item.done', item: message },
    closing,
  ]);
}

let server: Server;
let base: string;
let sandbox: string;
let env: NodeJS.ProcessEnv;
let behaviour: Behaviour;
let seen: { path: string; auth: string | undefined; body: Record<string, unknown> }[];

function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () =>
      resolve(raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {}),
    );
  });
}

function completion(content: string, finish = 'stop'): string {
  return JSON.stringify({ choices: [{ message: { content }, finish_reason: finish }] });
}

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-openai-'));
  env = { LOCALAPPDATA: sandbox, [KEY_ENV]: KEY };
  seen = [];
  behaviour = {
    models: 'ok',
    schema: 'enforced',
    object: true,
    answer: JSON.stringify({ ok: true }),
    finish: 'stop',
    echoHeaders: false,
    rateLimitFirst: 0,
    responses: 'none',
  };

  server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').replace(/^\/v1/, '');
      const body = await bodyOf(req);
      seen.push({ path, auth: req.headers.authorization, body });
      const send = (status: number, text: string, extra: Record<string, string> = {}): void => {
        res.writeHead(status, { 'content-type': 'application/json', ...extra });
        res.end(text);
      };
      // 429 一律帶 `Retry-After: 0`：測的是退避的**次數與順序**，不是等多久。
      const rateLimited = (): void => send(429, '{"error":"slow down"}', { 'retry-after': '0' });

      if (path === '/models') {
        if (behaviour.models === 'auth') return send(401, '{"error":"bad key"}');
        if (behaviour.models === 'missing-v1') return send(404, 'not found');
        return send(
          200,
          JSON.stringify({ data: [{ id: 'm1', context_length: 128000 }, { id: 'm2' }] }),
        );
      }

      if (path === '/responses') {
        if (behaviour.responses === 'none') return send(404, '{"error":"no such route"}');
        if (behaviour.rateLimitFirst > 0) {
          behaviour.rateLimitFirst -= 1;
          return rateLimited();
        }
        const format = (body['text'] as { format?: { type?: string } } | undefined)?.format;
        const input = String(body['input'] ?? '');
        const isProbe = input.includes('介紹你自己');
        const isObjectProbe = input.includes('欄位 ok，值是 true');
        const stream = (text: string): void => {
          if (behaviour.responses === 'json-body') {
            return send(
              200,
              JSON.stringify({
                status: 'completed',
                output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
              }),
            );
          }
          if (behaviour.responses === 'incomplete') {
            res.writeHead(200, { 'content-type': 'text/event-stream' });
            res.end(responsesStream('', 'response.incomplete', 'max_output_tokens'));
            return;
          }
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(responsesStream(text));
        };
        if (format?.type === 'json_schema') {
          if (behaviour.responses === 'rejected') {
            const echo = behaviour.echoHeaders ? ` auth=${req.headers.authorization ?? ''}` : '';
            return send(400, `{"error":"unsupported text.format json_schema"${echo}}`);
          }
          if (isProbe) {
            return stream(
              behaviour.responses === 'ignored'
                ? '我是一個語言模型。'
                : JSON.stringify({ probe: 'cyclosa-json-schema-probe', n: 7 }),
            );
          }
          return stream(behaviour.answer);
        }
        if (format?.type === 'json_object') {
          if (!behaviour.object) return send(400, '{"error":"no json mode"}');
          if (isObjectProbe) return stream(JSON.stringify({ ok: true }));
          return stream(behaviour.answer);
        }
        return stream('一般的回答');
      }

      if (path === '/chat/completions') {
        if (behaviour.rateLimitFirst > 0) {
          behaviour.rateLimitFirst -= 1;
          return rateLimited();
        }
        const fmt = body['response_format'] as { type?: string } | undefined;
        const messages = (body['messages'] as { content: string }[]) ?? [];
        const isProbe = messages.some((m) => m.content.includes('介紹你自己'));
        const isObjectProbe = messages.some((m) => m.content.includes('欄位 ok，值是 true'));

        if (fmt?.type === 'json_schema') {
          if (behaviour.schema === 'auth') return send(401, '{"error":"bad key"}');
          if (behaviour.schema === 'rate-limited') return rateLimited();
          if (behaviour.schema === 'rejected') {
            // 回顯在最前面：落在截斷的範圍之內，測得到的才是遮蔽本身，不是截斷剛好藏掉它。
            const echo = behaviour.echoHeaders ? ` auth=${req.headers.authorization ?? ''}` : '';
            return send(400, `{"error":"unsupported response_format json_schema"${echo}}`);
          }
          if (isProbe) {
            return send(
              200,
              completion(
                behaviour.schema === 'enforced'
                  ? JSON.stringify({ probe: 'cyclosa-json-schema-probe', n: 7 })
                  : '我是一個語言模型。',
              ),
            );
          }
          return send(200, completion(behaviour.answer, behaviour.finish));
        }

        if (fmt?.type === 'json_object') {
          if (!behaviour.object) return send(400, '{"error":"no json mode"}');
          if (isObjectProbe) return send(200, completion(JSON.stringify({ ok: true })));
          return send(200, completion(behaviour.answer, behaviour.finish));
        }
        return send(200, completion('一般的回答'));
      }
      send(404, 'nope');
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

const OK_SCHEMA = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
} as const;

function chat(model = 'm1') {
  return createOpenAiChat(base, model, KEY_ENV, env);
}

const completions = (): number => seen.filter((s) => s.path === '/chat/completions').length;
const responses = (): number => seen.filter((s) => s.path === '/responses').length;

// ── 模型清單與探測 ─────────────────────────────────────────────

describe('模型清單與探測', () => {
  it('列得出 /models 的 id，而且帶的是環境變數的**值**', async () => {
    expect(await listOpenAiModels(base, KEY_ENV, env)).toEqual(['m1', 'm2']);
    expect(seen[0]?.auth).toBe(`Bearer ${KEY}`);
  });

  it('被拒的時候是 null，不是「一個都沒有」', async () => {
    behaviour.models = 'auth';
    expect(await listOpenAiModels(base, KEY_ENV, env)).toBeNull();
  });

  it('就緒時帶出對方報的 context；沒報的是 0（不知道）', async () => {
    const p1 = await chat('m1').probe();
    const p2 = await chat('m2').probe();
    expect(p1.kind === 'ready' && p1.capabilities.context_tokens).toBe(128000);
    expect(p2.kind === 'ready' && p2.capabilities.context_tokens).toBe(0);
  });

  it('清單上沒有的模型 ＝ 沒設定（跟 Ollama 那邊同一個判準）', async () => {
    expect((await chat('not-there').probe()).kind).toBe('not-configured');
  });

  it('金鑰被拒要說出來，不是「連不上」', async () => {
    behaviour.models = 'auth';
    const p = await chat().probe();
    expect(p.kind).toBe('unreachable');
    if (p.kind === 'unreachable') expect(p.detail).toContain('金鑰被拒');
  });

  it('/models 回 404 時提示位址通常以 /v1 結尾', async () => {
    behaviour.models = 'missing-v1';
    const p = await chat().probe();
    if (p.kind === 'unreachable') expect(p.detail).toContain('/v1');
    else expect.fail(p.kind);
  });

  it('**打開設定頁不產生任何一次對話請求** —— probe 與 jsonMode 只讀', async () => {
    await chat().probe();
    await chat().jsonMode();
    expect(completions()).toBe(0);
  });
});

// ── 格式量測 ──────────────────────────────────────────────────

describe('格式量測（checkJson）', () => {
  it('真的套用 → schema，而且帶著時間記下來', async () => {
    const before = Date.now();
    const r = await chat().checkJson!();
    expect(r.kind === 'ok' && r.value.mode).toBe('schema');
    const stored = [...(await readJsonChecks(env)).values()];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.checkedAt).toBeGreaterThanOrEqual(before);
  });

  /**
   * **這一條是量測設計存在的理由。** 一個收了 `response_format` 卻沒有照做的端點，
   * 在「用一句話介紹你自己」那一題會回一句自我介紹 —— 而不是被當成支援。
   */
  it('收了但安靜忽略 → 往下一級量，結果是 object，而且說出為什麼', async () => {
    behaviour.schema = 'ignored';
    const r = await chat().checkJson!();
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.mode).toBe('object');
      expect(r.value.detail).toContain('收了但沒有套用');
    }
  });

  it('直接拒絕、但 json_object 可以 → object', async () => {
    behaviour.schema = 'rejected';
    const r = await chat().checkJson!();
    expect(r.kind === 'ok' && r.value.mode).toBe('object');
  });

  it('兩種都不行 → none', async () => {
    behaviour.schema = 'rejected';
    behaviour.object = false;
    const r = await chat().checkJson!();
    expect(r.kind === 'ok' && r.value.mode).toBe('none');
  });

  /**
   * **量不出來的時候什麼都不記。** 記成 `none` 的話，一次暫時的限流或打錯的金鑰
   * 會變成一個永久的「這個端點不支援」。
   */
  it.each([
    ['auth', 'PROVIDER_AUTH_REJECTED'],
    ['rate-limited', 'PROVIDER_RATE_LIMITED'],
  ] as const)('%s → %s，不記任何結果', async (mode, code) => {
    behaviour.schema = mode;
    const r = await chat().checkJson!();
    expect(r.kind === 'error' && r.code).toBe(code);
    expect((await readJsonChecks(env)).size).toBe(0);
  });

  /**
   * **429 照官方 SDK 的做法退避重試**（`domain/provider/rate-limit.ts`）：
   * 一直 429 就是 1 次 ＋ 2 次重試 ＝ 3 個請求，然後才是 `PROVIDER_RATE_LIMITED`。
   * 2026-09-13 之前這一條寫著「只打一次 —— 立刻停、不重試」。
   */
  it('一直 429 → 打三次（退避兩次）才放棄', async () => {
    behaviour.schema = 'rate-limited';
    const r = await chat().checkJson!();
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_RATE_LIMITED');
    expect(completions()).toBe(3);
  });

  it('429 一次之後就好了 → 量測成功，總共兩個請求', async () => {
    behaviour.rateLimitFirst = 1;
    const r = await chat().checkJson!();
    expect(r.kind === 'ok' && r.value.mode).toBe('schema');
    expect(completions()).toBe(2);
  });
});

// ── 任務呼叫 ──────────────────────────────────────────────────

describe('json()', () => {
  it('沒量過就先量，然後照量到的模式送', async () => {
    const r = await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(r.kind).toBe('ok');
    // 量測一次（json_schema 支援就不會打第二次）＋ 任務一次
    expect(completions()).toBe(2);
    const task = seen.at(-1)?.body['response_format'] as { type: string };
    expect(task.type).toBe('json_schema');
  });

  it('量過之後不再量 —— 一次量測不該每跑一次任務就付一次錢', async () => {
    await chat().checkJson!();
    const n = completions();
    await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(completions()).toBe(n + 1);
  });

  it('object 模式：送 json_object，schema 寫進系統提示', async () => {
    behaviour.schema = 'rejected';
    await chat().checkJson!();
    const r = await chat().json({ system: '原本的系統提示', user: 'u', schema: OK_SCHEMA });
    expect(r.kind).toBe('ok');
    const task = seen.at(-1)?.body;
    expect((task?.['response_format'] as { type: string }).type).toBe('json_object');
    const system = (task?.['messages'] as { role: string; content: string }[])[0]?.content ?? '';
    expect(system).toContain('原本的系統提示');
    expect(system).toContain('"required":["ok"]');
  });

  /**
   * **注入。** 端點不保證形狀時，一份夾帶了「動作」的回應要被擋下來 ——
   * 這是 `expansion-prompts.ts` 檔頭三層防護的第二層，在這種端點上由這裡執行。
   */
  it('object 模式：形狀不對 → SCHEMA_MISMATCH，不是 ok', async () => {
    behaviour.schema = 'rejected';
    behaviour.answer = JSON.stringify({ ok: true, action: 'confirm-all-edges' });
    await chat().checkJson!();
    const r = await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_OUTPUT_SCHEMA_MISMATCH');
    if (r.kind === 'error') expect(r.detail).toContain('$.action');
  });

  it('schema 模式也驗 —— 端點說支援卻沒做到，一樣擋', async () => {
    behaviour.answer = JSON.stringify({ ok: 'yes' });
    await chat().checkJson!();
    const r = await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_OUTPUT_SCHEMA_MISMATCH');
  });

  it('none → 停手，而且一次對話請求都不送', async () => {
    behaviour.schema = 'rejected';
    behaviour.object = false;
    await chat().checkJson!();
    const n = completions();
    const r = await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_JSON_UNSUPPORTED');
    expect(completions()).toBe(n);
  });

  /**
   * **量測舊了。** 上次量的是支援，這次卻被拒 —— 說出來、叫人重新檢查，
   * **不自己換一個模式重送**：那會讓結果來自一組跟畫面上顯示的不同的條件。
   */
  it('schema 模式被拒 → 說量測可能舊了，而且不換模式重送', async () => {
    await chat().checkJson!();
    behaviour.schema = 'rejected';
    const n = completions();
    const r = await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_JSON_UNSUPPORTED');
    if (r.kind === 'error') expect(r.detail).toContain('重新檢查');
    expect(completions()).toBe(n + 1);
  });

  it('被截斷的空回應說得出是被截斷，不只是「解析不出來」', async () => {
    behaviour.answer = '';
    behaviour.finish = 'length';
    await chat().checkJson!();
    const r = await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_OUTPUT_UNPARSEABLE');
    if (r.kind === 'error') expect(r.detail).toContain('finish_reason=length');
  });

  it('金額成本是 null（這個協定不回報），不是 0', async () => {
    const r = await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(r.cost.costUsd).toBeNull();
  });
});

// ── 金鑰不外洩 ─────────────────────────────────────────────────

describe('金鑰只存名字', () => {
  /**
   * 有的伺服器會把請求標頭回顯在錯誤內文裡，而那一段會進 `detail` ——
   * `detail` 會進日誌、進 `provider-checks.json`、在求助時被整份貼出來。
   */
  it('錯誤內文把 Authorization 回顯出來，detail 與量測檔裡都沒有金鑰', async () => {
    behaviour.schema = 'rejected';
    behaviour.echoHeaders = true;
    const r = await chat().checkJson!();
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.value.detail).not.toContain(KEY);
      expect(r.value.detail).toContain('***');
    }
    const file = await readFile(checksFilePath(env), 'utf8');
    expect(file).not.toContain(KEY);
  });
});

// ── Responses API（v0.24.2）──────────────────────────────────

/**
 * 假端點把 `/responses` 打開之後的那一半。**前面每一條測試都是在 404 的前提下跑的**，
 * 所以這裡只測「有那條路」才會發生的事。
 */
describe('先走 Responses API', () => {
  beforeEach(() => {
    behaviour.responses = 'enforced';
  });

  it('量測走 /responses：請求是 instructions ＋ input ＋ text.format，串流；一次 chat 請求都不送', async () => {
    const r = await chat().checkJson!();
    expect(r.kind === 'ok' && r.value.mode).toBe('schema');
    expect(r.kind === 'ok' && r.value.protocol).toBe('responses');
    expect(completions()).toBe(0);
    const sent = seen.find((x) => x.path === '/responses')?.body ?? {};
    expect(sent['stream']).toBe(true);
    expect(typeof sent['instructions']).toBe('string');
    expect(typeof sent['input']).toBe('string');
    expect((sent['text'] as { format: { type: string } }).format.type).toBe('json_schema');
    expect(sent['messages']).toBeUndefined();
    // 記下來的協定也是它。
    const stored = [...(await readJsonChecks(env)).values()];
    expect(stored[0]?.protocol).toBe('responses');
    expect(stored[0]?.detail).toContain('Responses API');
  });

  it('json() 照量到的協定送，回應從串流的 output_item.done 組回來（completed 的 output 是空的）', async () => {
    const r = await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') expect(r.value).toEqual({ ok: true });
    expect(responses()).toBe(2);
    expect(completions()).toBe(0);
  });

  it('端點不理會 stream、回一整份 JSON 也讀得懂', async () => {
    behaviour.responses = 'json-body';
    const r = await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(r.kind).toBe('ok');
  });

  it('收了但安靜忽略 → 往下一級量，object 也走 Responses API', async () => {
    behaviour.responses = 'ignored';
    const r = await chat().checkJson!();
    expect(r.kind === 'ok' && r.value.mode).toBe('object');
    expect(r.kind === 'ok' && r.value.protocol).toBe('responses');
    const last = seen.at(-1)?.body ?? {};
    expect((last['text'] as { format: { type: string } }).format.type).toBe('json_object');
    expect(completions()).toBe(0);
  });

  it('json_schema 被拒 → object；被拒的內文遮掉金鑰', async () => {
    behaviour.responses = 'rejected';
    behaviour.echoHeaders = true;
    const r = await chat().checkJson!();
    expect(r.kind === 'ok' && r.value.mode).toBe('object');
    if (r.kind === 'ok') {
      expect(r.value.detail).not.toContain(KEY);
      expect(r.value.detail).toContain('***');
    }
  });

  it('沒有 /responses 的端點：量到的協定是 chat，而且記下來', async () => {
    behaviour.responses = 'none';
    const r = await chat().checkJson!();
    expect(r.kind === 'ok' && r.value.protocol).toBe('chat');
    expect(responses()).toBe(1);
    expect(completions()).toBe(1);
    expect([...(await readJsonChecks(env)).values()][0]?.protocol).toBe('chat');
  });

  it('串流說沒完成 → 說得出「沒有完成」與對方的理由', async () => {
    await chat().checkJson!();
    behaviour.responses = 'incomplete';
    const r = await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_OUTPUT_UNPARSEABLE');
    if (r.kind === 'error') expect(r.detail).toContain('max_output_tokens');
  });

  /**
   * **量測舊了的第二種**：量的時候有 /responses，現在沒有了 —— 說出來、叫人重新檢查，
   * 不自己換 Chat Completions 重送。
   */
  it('量過 Responses API，之後那條路不見了 → 叫人重新檢查，不換協定重送', async () => {
    await chat().checkJson!();
    behaviour.responses = 'none';
    const r = await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(r.kind === 'error' && r.code).toBe('PROVIDER_JSON_UNSUPPORTED');
    if (r.kind === 'error') expect(r.detail).toContain('重新檢查');
    expect(completions()).toBe(0);
  });

  /**
   * v0.24.1 之前的紀錄沒有 `protocol`，而那些是對 Chat Completions 量的。
   * 讀到就當沒量過：下一次會重量一次（一到兩個小請求），而不是拿舊協定的結果當新協定的。
   */
  it('沒有 protocol 欄位的舊紀錄 ＝ 沒量過', async () => {
    const path = checksFilePath(env);
    await mkdir(dirname(path), { recursive: true });
    const key = `${base}|m1`;
    await writeFile(
      path,
      JSON.stringify({ [key]: { mode: 'schema', checkedAt: 1, detail: 'json_schema' } }),
      'utf8',
    );
    expect((await chat().jsonMode()).mode).toBe('unchecked');
    const r = await chat().json({ system: 's', user: 'u', schema: OK_SCHEMA });
    expect(r.kind).toBe('ok');
    expect([...(await readJsonChecks(env)).values()][0]?.protocol).toBe('responses');
  });

  it('429 一次之後就好了 → 兩個 /responses 請求', async () => {
    behaviour.rateLimitFirst = 1;
    const r = await chat().checkJson!();
    expect(r.kind === 'ok' && r.value.mode).toBe('schema');
    expect(responses()).toBe(2);
  });
});
