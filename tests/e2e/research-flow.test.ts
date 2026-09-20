/**
 * 端對端：**「研究」的規劃那一半**（Stage 19，ADR-0033、REQ-0009 R1–R6）。
 *
 * ## 什麼是假的、什麼是真的
 *
 * **假的只有模型本身**：一台起在 `127.0.0.1` 的假 Ollama。其餘全部是真的 ——
 * `providers.json` 真的被讀、HTTP client 真的送出去、全文檢索真的跑（對著**範例專題**，
 * 它走的是真的匯入管線）、三張表真的寫進 SQLite、那條「同時只有一次」真的由索引擋。
 *
 * ## 這一份要證明的事
 *
 * 1. **開一次研究不花錢**：一次模型呼叫都沒有，而命中是全文檢索算的（R1）。
 * 2. **閘門一之前不會有任何搜尋或擷取**（R5）—— 這一版連蒐集都還沒接上，
 *    所以這裡驗的是狀態與方向表，而不是「沒有抓到東西」。
 * 3. **改方向不花錢，而且人改過的不會被模型改回去**（R4）。
 * 4. **超過上限要說**（R6）。
 * 5. **模型回垃圾不會弄壞這次研究** —— 記成失敗的一輪，還可以再談。
 * 6. **同一個專題同時只有一次研究**（D4）。
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { initDataRoot } from '../../src/application/bootstrap-service.js';
import { createSampleCase } from '../../src/application/sample-service.js';
import {
  abandonResearch,
  converse,
  deleteResearch,
  editDirections,
  listResearchViews,
  startCollecting,
  startResearch,
} from '../../src/application/research-service.js';
import { MAX_DIRECTIONS } from '../../src/domain/provider/plan.js';

/** 假 Ollama 這一次要回什麼。每個測試自己換。 */
let reply: unknown = {};
/** 每一次 `/api/chat` 收到的提示詞 —— **「模型當時看到什麼」只看得到這個**。 */
const prompts: string[] = [];
/** 模型宣告多大的 context。**小於 18000 就配不上 `TASK_PLAN`。** */
let contextTokens = 128_000;

let ollama: Server;
let ollamaBase = '';
let sandbox = '';
let dataRoot = '';
let slug = '';
let saved: string | undefined;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => resolve(raw));
  });
}

const plan = (titles: readonly string[], extra: Record<string, unknown> = {}): unknown => ({
  reply: '我建議這樣切',
  relation: '這個主題跟專題裡那幾條條文講的是同一件事',
  directions: titles.map((title) => ({
    title,
    what: `要找 ${title} 的原始出處`,
    expect: '法規原文',
    keywords: [title],
  })),
  out_of_scope: ['外國法'],
  ...extra,
});

async function writeProvidersFile(model = 'fake-model'): Promise<void> {
  const dir = join(sandbox, 'LocalAppData', 'Cyclosa');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'providers.json'),
    JSON.stringify({
      version: 2,
      connections: {
        cli: null,
        ollama: { baseUrl: ollamaBase, apiKeyEnv: null },
        openai: null,
      },
      tasks: {
        // **規劃對話走本機 Ollama** —— 三條路裡唯一不用外部程序或金鑰就跑得起來的。
        plan: { via: 'ollama', model },
        'find-sources': { via: 'cli', model: '' },
        angles: { via: 'ollama', model },
        extract: { via: 'ollama', model },
        embed: { via: 'ollama', model: '' },
      },
      diagnostics: { logModelCalls: false },
    }),
    'utf8',
  );
}

beforeAll(async () => {
  ollama = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'fake-model',
              capabilities: ['completion'],
              details: { context_length: contextTokens },
            },
          ],
        }),
      );
      return;
    }
    if (path === '/api/chat') {
      void readBody(req).then((raw) => {
        const body = JSON.parse(raw) as { messages?: { role: string; content: string }[] };
        prompts.push(body.messages?.map((m) => m.content).join('\n') ?? '');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ message: { content: JSON.stringify(reply) } }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
  const address = ollama.address();
  ollamaBase = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => ollama.close(() => r()));
});

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-research-'));
  dataRoot = join(sandbox, 'DataRoot');
  saved = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'LocalAppData');
  await mkdir(process.env['LOCALAPPDATA'], { recursive: true });

  prompts.length = 0;
  contextTokens = 128_000;
  reply = plan(['條文原文能不能重製', '合理使用的判斷基準']);
  await writeProvidersFile();

  const root = await initDataRoot(dataRoot);
  expect(root.ok).toBe(true);
  const made = await createSampleCase(dataRoot);
  if (!made.ok) throw new Error(made.code);
  slug = made.data.slug;
});

afterEach(async () => {
  if (saved === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = saved;
  await rm(sandbox, { recursive: true, force: true });
});

describe('開一次研究', () => {
  it('不花錢：一次模型呼叫都沒有，而命中是全文檢索算的（R1）', async () => {
    const started = await startResearch(dataRoot, slug, { topic: '合理使用' });
    expect(started.ok, JSON.stringify(started)).toBe(true);
    if (!started.ok) return;

    expect(prompts).toEqual([]);
    expect(started.data.status).toBe('planning');
    expect(started.data.hitTotal).toBeGreaterThan(0);
    // 範例專題裡真的有講「合理使用」的條文 —— 這一條同時證明索引是真的。
    expect(started.data.hits.length).toBeGreaterThan(0);
    expect(started.data.hits[0]?.title.length).toBeGreaterThan(0);
    expect(started.data.messages).toEqual([]);
    expect(started.data.plan.directions).toEqual([]);
    // 走本機 Ollama：不花錢、不會上網查（D5）。
    expect(started.data.service).toMatchObject({ via: 'ollama', costs: false, browses: false });
  });

  it('一個字都沒命中也照開，而且照實說 0 份', async () => {
    const started = await startResearch(dataRoot, slug, { topic: '量子重力的實驗設計' });
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    expect(started.data.hits).toEqual([]);
    expect(started.data.hitTotal).toBeGreaterThan(0);
  });

  it('主題是空的就不開', async () => {
    const started = await startResearch(dataRoot, slug, { topic: '   ' });
    expect(started.ok).toBe(false);
    if (started.ok) return;
    expect(started.code).toBe('SEARCH_QUERY_EMPTY');
  });

  it('同一個專題同時只有一次沒結束的（D4）', async () => {
    const first = await startResearch(dataRoot, slug, { topic: '合理使用' });
    expect(first.ok).toBe(true);
    const second = await startResearch(dataRoot, slug, { topic: '政府資訊公開' });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.code).toBe('RESEARCH_ALREADY_OPEN');
  });
});

describe('談一輪', () => {
  it('模型看得到專題摘要與主題，交出的方向存得下來', async () => {
    const started = await startResearch(dataRoot, slug, { topic: '合理使用' });
    if (!started.ok) return;
    const said = await converse(dataRoot, slug, started.data.id, '我想看條文本身怎麼說');
    expect(said.ok, JSON.stringify(said)).toBe(true);
    if (!said.ok) return;

    expect(prompts).toHaveLength(1);
    // 提示詞裡要有主題、使用者說的話，以及命中的那幾份（R3）。
    expect(prompts[0]).toContain('合理使用');
    expect(prompts[0]).toContain('我想看條文本身怎麼說');
    expect(prompts[0]).toContain('<專題>');

    expect(said.data.plan.directions.map((d) => d.title)).toEqual([
      '條文原文能不能重製',
      '合理使用的判斷基準',
    ]);
    expect(said.data.plan.outOfScope).toEqual(['外國法']);
    expect(said.data.plan.directions.every((d) => d.origin === 'model')).toBe(true);
    // 一輪 ＝ 使用者一列 ＋ 模型一列。
    expect(said.data.messages.map((m) => m.role)).toEqual(['user', 'model']);
    expect(said.data.messages[1]?.model).toBe('ollama:fake-model');
    // 本機模型真的是 0 —— 而「不知道」是 null（`unknownCost` 數的就是它）。
    expect(said.data.unknownCost).toBe(0);
  });

  it('模型提太多條：留 12 條，而且畫面說得出它提超過了（R6）', async () => {
    const started = await startResearch(dataRoot, slug, { topic: '合理使用' });
    if (!started.ok) return;
    reply = plan(Array.from({ length: MAX_DIRECTIONS + 4 }, (_, i) => `方向 ${String(i)}`));
    const said = await converse(dataRoot, slug, started.data.id, '盡量窮舉');
    expect(said.ok).toBe(true);
    if (!said.ok) return;
    expect(said.data.plan.directions).toHaveLength(MAX_DIRECTIONS);
    expect(said.data.plan.overflow).toBe(true);
  });

  it('模型回垃圾：記成失敗的一輪，這次研究還活著', async () => {
    const started = await startResearch(dataRoot, slug, { topic: '合理使用' });
    if (!started.ok) return;
    reply = { 這不是規劃: true };
    const bad = await converse(dataRoot, slug, started.data.id, '再來一次');
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    // Ollama 那一條有 schema 保證，所以形狀不對會先被它擋下來；
    // 兩種碼都代表同一件事：**這一輪沒有交出可以用的規劃**。
    expect(['PROVIDER_OUTPUT_UNPARSEABLE', 'PROVIDER_OUTPUT_SCHEMA_MISMATCH']).toContain(bad.code);

    reply = plan(['重新來過的方向']);
    const good = await converse(dataRoot, slug, started.data.id, '再試一次');
    expect(good.ok).toBe(true);
    if (!good.ok) return;
    expect(good.data.plan.directions.map((d) => d.title)).toEqual(['重新來過的方向']);
    // 失敗的那一輪留著（`code` 有值）—— 它是回報問題時唯一查得到的東西。
    expect(good.data.messages.some((m) => m.code !== null)).toBe(true);
  });

  it('context 不夠就停手，而且說得出缺什麼（ADR-0006）', async () => {
    contextTokens = 4_000;
    const started = await startResearch(dataRoot, slug, { topic: '合理使用' });
    if (!started.ok) return;
    const said = await converse(dataRoot, slug, started.data.id, '開始吧');
    expect(said.ok).toBe(false);
    if (said.ok) return;
    expect(said.code).toBe('PROVIDER_CAPABILITY_MISSING');
    // **配不上的時候一次呼叫都沒送出去。**
    expect(prompts).toEqual([]);
  });
});

describe('改方向、閘門一', () => {
  it('人改過的標「你改的」，而且模型下一輪不會把它改回去（R4）', async () => {
    const started = await startResearch(dataRoot, slug, { topic: '合理使用' });
    if (!started.ok) return;
    await converse(dataRoot, slug, started.data.id, '先給我方向');

    const edited = await editDirections(dataRoot, slug, started.data.id, [
      { title: '條文原文能不能重製', what: '我自己改過的說明', expect: '法規原文' },
      { title: '我自己加的一條', what: '', expect: '' },
    ]);
    expect(edited.ok, JSON.stringify(edited)).toBe(true);
    if (!edited.ok) return;
    // 刪掉一條、改一條、加一條 —— 改過與新增的都是人提的。
    expect(edited.data.plan.directions.map((d) => [d.title, d.origin])).toEqual([
      ['條文原文能不能重製', 'human'],
      ['我自己加的一條', 'human'],
    ]);
    // 改方向不花錢。
    expect(prompts).toHaveLength(1);

    // 模型下一輪又只提它自己那兩條 —— 人加的那一條要留著。
    reply = plan(['條文原文能不能重製', '合理使用的判斷基準']);
    const again = await converse(dataRoot, slug, started.data.id, '再看一次');
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    const titles = again.data.plan.directions.map((d) => d.title);
    expect(titles).toContain('我自己加的一條');
    const mine = again.data.plan.directions.find((d) => d.title === '條文原文能不能重製');
    expect(mine?.what).toBe('我自己改過的說明');
    expect(mine?.origin).toBe('human');
  });

  it('閘門一：方向落成一張表，沒被採用的也留著（D5）', async () => {
    const started = await startResearch(dataRoot, slug, { topic: '合理使用' });
    if (!started.ok) return;
    await converse(dataRoot, slug, started.data.id, '先給我方向');
    // 使用者刪掉第二條。
    await editDirections(dataRoot, slug, started.data.id, [{ title: '條文原文能不能重製' }]);

    const gate = await startCollecting(dataRoot, slug, started.data.id);
    expect(gate.ok, JSON.stringify(gate)).toBe(true);
    if (!gate.ok) return;
    expect(gate.data.status).toBe('collecting');
    expect(gate.data.directions.map((d) => [d.title, d.adopted])).toEqual([
      ['條文原文能不能重製', true],
      ['合理使用的判斷基準', false],
    ]);

    // 過了閘門一就不能再談、也不能再改方向。
    const late = await converse(dataRoot, slug, started.data.id, '等一下');
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.code).toBe('RESEARCH_STEP_INVALID');
    const edit = await editDirections(dataRoot, slug, started.data.id, [{ title: '再加一條' }]);
    expect(edit.ok).toBe(false);
  });

  it('一條方向都沒有的時候，閘門一按不下去（R5）', async () => {
    const started = await startResearch(dataRoot, slug, { topic: '合理使用' });
    if (!started.ok) return;
    const gate = await startCollecting(dataRoot, slug, started.data.id);
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.code).toBe('RESEARCH_STEP_INVALID');
  });
});

describe('放棄與刪除', () => {
  it('進行中的刪不掉；放棄之後才刪得掉，而且歷次紀錄看得到', async () => {
    const started = await startResearch(dataRoot, slug, { topic: '合理使用' });
    if (!started.ok) return;
    const id = started.data.id;

    const tooEarly = await deleteResearch(dataRoot, slug, id);
    expect(tooEarly.ok).toBe(false);

    const given = await abandonResearch(dataRoot, slug, id);
    expect(given.ok).toBe(true);
    if (!given.ok) return;
    expect(given.data.status).toBe('abandoned');

    const listed = await listResearchViews(dataRoot, slug);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.data.map((r) => r.id)).toEqual([id]);

    // 放棄之後可以再開一次。
    const again = await startResearch(dataRoot, slug, { topic: '政府資訊公開' });
    expect(again.ok, JSON.stringify(again)).toBe(true);

    const gone = await deleteResearch(dataRoot, slug, id);
    expect(gone.ok).toBe(true);
    const after = await listResearchViews(dataRoot, slug);
    expect(after.ok && after.data.map((r) => r.topic)).toEqual(['政府資訊公開']);
  });

  it('診斷開著的時候，規劃那一輪留得下紀錄（R29）', async () => {
    await writeProvidersFile();
    const dir = join(sandbox, 'LocalAppData', 'Cyclosa');
    const raw = JSON.parse(await readFile(join(dir, 'providers.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      join(dir, 'providers.json'),
      JSON.stringify({ ...raw, diagnostics: { logModelCalls: true } }),
      'utf8',
    );

    const started = await startResearch(dataRoot, slug, { topic: '合理使用' });
    if (!started.ok) return;
    const said = await converse(dataRoot, slug, started.data.id, '先給我方向');
    expect(said.ok).toBe(true);

    const log = await readFile(
      join(dataRoot, 'cases', slug, 'model-calls', `${started.data.id}.jsonl`),
      'utf8',
    );
    const record = JSON.parse(log.trim().split('\n')[0] as string) as Record<string, unknown>;
    expect(record['task']).toBe('plan');
    expect(String(record['transport'])).toBe('ollama');
    // **金鑰不會進去**，端點只記 host。
    expect(JSON.stringify(record)).not.toContain('apiKeyEnv');
  });
});
