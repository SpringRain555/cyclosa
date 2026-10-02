import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { initDataRoot } from '../../src/application/bootstrap-service.js';
import { createSampleCase } from '../../src/application/sample-service.js';
import { startResearch, getResearchView } from '../../src/application/research-service.js';
import { assessResearchGap } from '../../src/application/research-gap.js';
import { openCaseDatabase, type DatabaseSync } from '../../src/infrastructure/db/database.js';
import * as research from '../../src/infrastructure/db/repositories/research-repo.js';
import { newId } from '../../src/shared/id.js';
import { clearFakeClaudeEnv, writeFakeClaude } from './fake-claude.js';

let server: Server;
let baseUrl = '';
let sandbox = '';
let root = '';
let slug = '';
let researchId = '';
let saved: string | undefined;
let script = '';
let answer: unknown;
const requests: Record<string, unknown>[] = [];

async function inDb<T>(body: (db: DatabaseSync) => T): Promise<T> {
  const opened = await openCaseDatabase(join(root, 'cases', slug, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(opened.kind);
  try {
    return body(opened.db);
  } finally {
    opened.db.close();
  }
}

async function configure(via: 'cli' | 'openai' | 'ollama', diagnostics = true): Promise<void> {
  const configDir = join(sandbox, 'LocalAppData', 'Cyclosa');
  await mkdir(configDir, { recursive: true });
  await writeFile(
    join(configDir, 'providers.json'),
    JSON.stringify({
      version: 2,
      connections: {
        cli: { command: process.execPath, args: [script] },
        ollama: { baseUrl, apiKeyEnv: null },
        openai: { baseUrl, apiKeyEnv: null },
      },
      tasks: Object.fromEntries(
        ['plan', 'find-sources', 'digest', 'angles', 'extract', 'embed'].map((task) => [
          task,
          {
            via: task === 'plan' ? via : 'ollama',
            model: task === 'plan' ? 'gap-model' : 'other-model',
          },
        ]),
      ),
      diagnostics: { logModelCalls: diagnostics },
    }),
    'utf8',
  );
}

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/tags') {
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'gap-model',
              capabilities: ['completion'],
              details: { context_length: 128000 },
            },
          ],
        }),
      );
    } else if (req.url === '/models') {
      res.end(JSON.stringify({ data: [{ id: 'gap-model' }] }));
    } else if (req.url === '/api/chat' || req.url === '/responses') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        requests.push(JSON.parse(raw) as Record<string, unknown>);
        if (req.url === '/api/chat') {
          res.end(JSON.stringify({ message: { content: JSON.stringify(answer) }, done: true }));
        } else {
          res.end(
            JSON.stringify({
              status: 'completed',
              output: [
                {
                  type: 'message',
                  content: [{ type: 'output_text', text: JSON.stringify(answer) }],
                },
              ],
            }),
          );
        }
      });
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cy-gap-'));
  root = join(sandbox, 'data');
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'LocalAppData');
  script = await writeFakeClaude(sandbox);
  clearFakeClaudeEnv();
  process.env['CYCLOSA_FAKE_CLAUDE_LOG'] = join(sandbox, 'calls.jsonl');
  answer = { opinion: '這條方向只有一份候選，初讀不足以判斷是否完整。' };
  requests.length = 0;
  await configure('ollama');
  expect((await initDataRoot(root)).ok).toBe(true);
  const sample = await createSampleCase(root);
  if (!sample.ok) throw new Error(sample.code);
  slug = sample.data.slug;
  const started = await startResearch(root, slug, { topic: '不應傳出的主題' });
  if (!started.ok) throw new Error(started.code);
  researchId = started.data.id;
  await inDb((db) => {
    const directionId = newId();
    research.insertDirection(db, {
      id: directionId,
      researchId,
      ord: 0,
      title: '測試方向',
      what: '要找原始資料',
      expect: '原文',
      keywords: ['測試'],
      origin: 'human',
      adopted: true,
      now: Date.now(),
    });
    research.addCandidate(db, {
      id: newId(),
      researchId,
      directionId,
      url: 'https://not-sent.test/private',
      title: '合成候選',
      why: '不應傳出的搜尋理由',
      bib: { authors: '', year: '', venue: '' },
      expectedAccess: 'unknown',
      acquisition: 'needs-user',
      now: Date.now(),
    });
    research.updateResearchStatus(db, researchId, 'reviewing', Date.now());
  });
});

afterEach(async () => {
  clearFakeClaudeEnv();
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

it.each(['cli', 'openai', 'ollama'] as const)(
  '%s：不給工具、只傳允許素材、存入研究與 plan 花費',
  async (via) => {
    await configure(via);
    process.env['CYCLOSA_FAKE_CLAUDE_PLAN'] = JSON.stringify(answer);
    const before = await getResearchView(root, slug, researchId);
    expect(before.ok && before.data.gap).toBeNull();
    expect(requests).toHaveLength(0);
    const result = await assessResearchGap(root, slug, researchId);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    expect(result.data.gap).toMatchObject(answer as object);
    expect(result.data.costByTask['plan']?.requests).toBe(1);
    expect(result.data.status).toBe('reviewing');
    let prompt: string;
    if (via === 'cli') {
      const call = JSON.parse((await readFile(join(sandbox, 'calls.jsonl'), 'utf8')).trim()) as {
        argv: string[];
        prompt: string;
      };
      expect(call.argv[call.argv.indexOf('--tools') + 1]).toBe('');
      expect(call.argv).not.toContain('--allowedTools');
      expect(call.argv).not.toContain('WebSearch');
      expect(call.argv[call.argv.indexOf('--model') + 1]).toBe('gap-model');
      prompt = call.prompt;
      expect(result.data.costUsd).toBeCloseTo(0.05);
    } else {
      expect(requests).toHaveLength(1);
      const sent = requests[0]!;
      expect(sent).not.toHaveProperty('tools');
      expect(sent).not.toHaveProperty('tool_choice');
      expect(sent['model']).toBe('gap-model');
      prompt =
        via === 'openai'
          ? String(sent['input'])
          : (sent['messages'] as { content: string }[])[1]!.content;
      expect(result.data.gap?.costUsd).toBe(via === 'ollama' ? 0 : null);
      expect(result.data.unknownCost).toBe(via === 'openai' ? 1 : 0);
    }
    const input = JSON.parse(prompt) as {
      directions: { tally: { found: number }; candidates: { title: string }[] }[];
    };
    expect(input.directions[0]?.tally.found).toBe(1);
    expect(input.directions[0]?.candidates[0]?.title).toBe('合成候選');
    expect(prompt).not.toContain('not-sent.test');
    expect(prompt).not.toContain('不應傳出');
    await inDb((db) => {
      expect(JSON.parse(research.getResearch(db, researchId)!.gapJson!)).toEqual(result.data.gap);
    });
    const reloaded = await getResearchView(root, slug, researchId);
    expect(reloaded.ok && reloaded.data.gap).toEqual(result.data.gap);
    const log = JSON.parse(
      (
        await readFile(join(root, 'cases', slug, 'model-calls', `${researchId}.jsonl`), 'utf8')
      ).trim(),
    ) as Record<string, unknown>;
    expect(log['task']).toBe('plan');
  },
);

it('錯誤形狀不覆蓋先前意見；失敗花費仍記入，診斷關閉不留檔', async () => {
  await configure('ollama', false);
  expect((await assessResearchGap(root, slug, researchId)).ok).toBe(true);
  const previous = await inDb((db) => research.getResearch(db, researchId)!.gapJson);
  answer = { opinion: 42 };
  const failed = await assessResearchGap(root, slug, researchId);
  expect(failed.ok).toBe(false);
  expect(await inDb((db) => research.getResearch(db, researchId)!.gapJson)).toBe(previous);
  const after = await getResearchView(root, slug, researchId);
  expect(after.ok && after.data.costByTask['plan']?.requests).toBe(2);
  await expect(
    readFile(join(root, 'cases', slug, 'model-calls', `${researchId}.jsonl`)),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

it('規劃期間不能評估，也不呼叫模型', async () => {
  await inDb((db) => research.updateResearchStatus(db, researchId, 'planning', Date.now()));
  const result = await assessResearchGap(root, slug, researchId);
  expect(result.ok).toBe(false);
  expect(requests).toHaveLength(0);
});
