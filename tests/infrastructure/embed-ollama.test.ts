/**
 * 本機 Ollama 的嵌入：兩件只在這一層看得到的事。
 *
 * 1. **前綴照表加，兩邊都加**（`domain/search/embed-prefix.ts`）—— 送出去的字串只看得到這裡
 * 2. **Ollama 自己撥不通執行程序的那一種 400，等一下再送**（2026-09-29 量嵌入模型時撞到的）；
 *    其餘的 400 一次就回報 —— 對一個真的壞掉的請求重送三次，只是把「壞了」延後三次說
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createOllamaEmbed } from '../../src/infrastructure/providers/embed-ollama.js';

const TRANSIENT =
  '{"error":"do embedding request: Post \\"http://127.0.0.1:56543/v1/embeddings\\": dial tcp 127.0.0.1:56543: bind: An operation on a socket could not be performed because the system lacked sufficient buffer space or because a queue was full."}';

/** 接下來幾次要回什麼。空了就回正常的向量。 */
let script: { status: number; body: string }[] = [];
const received: { model: string; input: string[] }[] = [];

let server: Server;
let base = '';

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => resolve(raw));
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    void readBody(req).then((raw) => {
      const body = JSON.parse(raw) as { model: string; input: string[] };
      received.push({ model: body.model, input: body.input });
      const next = script.shift();
      if (next !== undefined) {
        res.writeHead(next.status, { 'content-type': 'application/json' });
        res.end(next.body);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embeddings: body.input.map(() => [1, 0, 0]) }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  script = [];
  received.length = 0;
});

describe('前綴', () => {
  it('查詢與文件兩邊各照表加（e5-instruct 查詢加、文件不加）', async () => {
    const model = 'hf.co/Ralriki/multilingual-e5-large-instruct-GGUF:F16';
    const embed = createOllamaEmbed(base, model, []);
    await embed.embedDocuments(['一段文件']);
    await embed.embedQuery('一句查詢');
    expect(received[0]?.input).toEqual(['一段文件']);
    expect(received[1]?.input[0]?.startsWith('Instruct: ')).toBe(true);
    expect(received[1]?.input[0]?.endsWith('\nQuery: 一句查詢')).toBe(true);
  });

  it('要求文件前綴的模型，文件那一側也加（原本一律不加）', async () => {
    const embed = createOllamaEmbed(base, 'hf.co/nomic-ai/nomic-embed-text-v2-moe-GGUF:F16', []);
    await embed.embedDocuments(['a', 'b']);
    expect(received[0]?.input).toEqual(['search_document: a', 'search_document: b']);
  });
});

describe('Ollama 撥不通自己的執行程序', () => {
  it('那一種 400 等一下再送，第二次成功就是成功', async () => {
    script = [{ status: 400, body: TRANSIENT }];
    const embed = createOllamaEmbed(base, 'granite-embedding:278m', [1]);
    const out = await embed.embedDocuments(['x']);
    expect(out.kind).toBe('ok');
    expect(received).toHaveLength(2);
  });

  it('重試有上限：一直失敗就照實回報「連不上」', async () => {
    script = [
      { status: 400, body: TRANSIENT },
      { status: 400, body: TRANSIENT },
      { status: 400, body: TRANSIENT },
    ];
    const embed = createOllamaEmbed(base, 'granite-embedding:278m', [1, 1]);
    const out = await embed.embedDocuments(['x']);
    expect(out.kind).toBe('error');
    if (out.kind === 'error') expect(out.code).toBe('PROVIDER_UNREACHABLE');
    expect(received).toHaveLength(3);
  });

  it('別的 400 不重送 —— 對一個真的壞掉的請求重送，只是把「壞了」延後', async () => {
    script = [{ status: 400, body: '{"error":"model does not support embeddings"}' }];
    const embed = createOllamaEmbed(base, 'granite-embedding:278m', [1, 1, 1]);
    const out = await embed.embedDocuments(['x']);
    expect(out.kind).toBe('error');
    expect(received).toHaveLength(1);
  });
});
