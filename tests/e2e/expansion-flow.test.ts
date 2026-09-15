/**
 * LLM 擴展的端對端測試。
 *
 * ## 什麼是假的、什麼是真的
 *
 * **假的只有兩個 provider 本身**：一台起在 `127.0.0.1` 的假 Ollama，
 * 與一支用 node 跑的假 `claude` CLI。
 *
 * **其餘全部是真的** —— `providers.json` 真的被讀、Ollama 的 HTTP client
 * 真的送出去、子程序真的被 spawn、stream-json 真的被逐行解析、
 * 沙箱真的被掃、擷取管線真的抓（對另一台起在本機的伺服器）、
 * 引文真的在正文裡定位、邊真的寫進 SQLite。
 *
 * 換成 mock 我們自己的模組會快很多，而**那樣測到的就只剩下編排順序** ——
 * 這一階段真正會出錯的地方（子程序參數、NDJSON 解析、引文對不上）全部測不到。
 *
 * ## 這一份要證明的事
 *
 * 1. **兩階段之間有一個人**：`POST /runs` 不會開始抓。
 * 2. **配不上就停手**，而且說得出缺哪幾樣（ADR-0006）。
 * 3. **引文在原文裡找不到的關係不寫進去**（這一階段最重要的一條）。
 * 4. **沙箱裡不得出現抓取產物**（Phase F 的驗收條件）。
 * 5. **擴展前後對 `origin='human'` 的子集 diff 為空**（Phase E 的驗收條件）。
 * 6. **否決過的組合重跑不再出現**（墓碑，ADR-0016）。
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import { TASK_EXTRACT } from '../../src/domain/provider/capabilities.js';
import { createCase } from '../../src/application/case-service.js';
import { chooseAngles, startExpansion } from '../../src/application/expand-service.js';
import { getRun } from '../../src/application/run-service.js';
import { createEdge } from '../../src/application/edge-service.js';
import { transitionEdge } from '../../src/application/edge-service.js';
import { isActive } from '../../src/application/run-registry.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';

// ══ 合成的來源網頁 ═════════════════════════════════════════

/** **這一句要一字不差地被引用。** 引文定位就是在找它。 */
const QUOTE = '合成公司在二月宣布收購合成工作室，交易金額沒有揭露。';

const ARTICLE = `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8">
<title>合成報導：一樁沒有揭露金額的收購</title></head><body>
<article>
<h1>合成報導：一樁沒有揭露金額的收購</h1>
<p>這是一份合成的測試資料，不是任何真實來源。下面這一段刻意寫得夠長，
因為抽取信心的門檻之一是正文長度，而我們要測的是擴展不是那個門檻。</p>
<p>${QUOTE}兩家公司都沒有回應進一步的詢問，而這一段的存在是為了讓
上面那一句話有前後文，抽取器才不會把它整段丟掉。</p>
<p>第三段繼續講同一件事。關聯、出處、引文、獨立來源、墓碑、校準比例，
這些詞出現在這裡是為了讓中文的 bigram 索引有東西可以切，
同時也把這篇合成文章的長度推過抽取信心的門檻。</p>
<p>第四段。快照存的是原始位元組而且不可變，衍生物可以整批刪掉重算。
這幾句話同時也讓這篇文章的長度超過門檻，讓斷言測的是擴展而不是門檻本身。</p>
</article></body></html>`;

// ══ 假的兩個 provider ══════════════════════════════════════

/** `/api/tags` 要回報多大的 context。**小於 8000 就配不上 `TASK_ANGLES`。** */
let chatContextTokens = 128_000;

/**
 * 第二個模型的 context。**跟上面那個分開**，因為逐任務覆寫要驗的正是
 * 「閘門檢查的是實際會跑的那一個，不是設定頁上寫的那一個」——
 * 兩個模型共用同一個數字的話，那件事測不出來。
 */
let extractModelContextTokens = 128_000;

/** 每一次 `/api/chat` 用了哪個模型、是哪一種任務。**覆寫有沒有生效只看得到這個。** */
const chatCalls: { model: string; task: 'angles' | 'extract' }[] = [];

/** 假 Ollama 抽關聯時回什麼。每個測試自己換。 */
let extraction: unknown = { entities: [], relations: [] };

/** 假 Ollama 產生角度時回什麼。 */
let angles: unknown = {
  angles: [
    { question: '這樁收購的金額是多少？', stance: '資金流向', seeds: [] },
    { question: '被收購的一方怎麼說？', stance: '當事人說法', seeds: [] },
  ],
};

let ollama: Server;
let ollamaBase = '';
let sources: Server;
let sourcesBase = '';

let sandbox = '';
let dataRoot = '';
let slug = '';
let savedLocalAppData: string | undefined;
let agentScript = '';

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => resolve(raw));
  });
}

/**
 * 假的 `claude` CLI。
 *
 * **它只做兩件事**：`--version` 回一個版本，其餘印出一串 stream-json。
 * 模式由環境變數決定，因為那是唯一一個「測試設定得到、子程序讀得到」的管道。
 */
const FAKE_AGENT = `
import { writeFile } from 'node:fs/promises';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('9.9.9-fake\\n');
  process.exit(0);
}

const mode = process.env['CYCLOSA_FAKE_AGENT_MODE'] ?? 'ok';
const urls = (process.env['CYCLOSA_FAKE_AGENT_URLS'] ?? '').split(',').filter((u) => u.length > 0);

// **這是違規的那一種**：agent 自己把一份網頁存進沙箱。
if (mode === 'sandbox') await writeFile('grabbed.html', '<html>不該在這裡</html>', 'utf8');

// 一行雜訊 —— stream-json 是逐行的，壞掉一行不該讓整批壞掉。
process.stdout.write('this line is not json\\n');
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');

if (mode === 'fail') {
  process.stdout.write(
    JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, total_cost_usd: 0.18 }) + '\\n',
  );
  process.exit(0);
}

process.stdout.write(
  JSON.stringify({
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.18,
    result: JSON.stringify({ candidates: urls.map((url) => ({ url, why: '合成的理由' })) }),
  }) + '\\n',
);
`;

/**
 * `taskModels` 留空時**整個鍵都不寫** —— 那正是舊設定檔的形狀，
 * 而這個測試檔裡其餘每一條都走那條路，所以向後相容是被實際跑過的，不是宣稱的。
 */
async function writeProvidersFile(
  agent: boolean,
  taskModels?: Record<string, string>,
): Promise<void> {
  const dir = join(sandbox, 'LocalAppData', 'Cyclosa');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'providers.json'),
    JSON.stringify({
      version: 1,
      chat: { baseUrl: ollamaBase, model: 'fake-model', ...(taskModels ? { taskModels } : {}) },
      // **用 node 跑一支假的 CLI** —— `args` 這個設定欄位存在的理由就是這種包裝。
      agent: agent ? { command: process.execPath, args: [agentScript] } : null,
    }),
    'utf8',
  );
}

async function inDb<T>(fn: (db: DatabaseSync) => T): Promise<T> {
  const opened = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error('開不了專題資料庫');
  try {
    return fn(opened.db);
  } finally {
    opened.db.close();
  }
}

async function waitForRun(runId: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if (!isActive(runId)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('作業沒有在時限內結束');
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
              capabilities: ['completion', 'tools'],
              details: { context_length: chatContextTokens },
            },
            {
              name: 'fake-extract-model',
              capabilities: ['completion'],
              details: { context_length: extractModelContextTokens },
            },
          ],
        }),
      );
      return;
    }
    if (path === '/api/chat') {
      void readBody(req).then((raw) => {
        const body = JSON.parse(raw) as {
          model?: unknown;
          format?: { properties?: Record<string, unknown> };
        };
        // **靠 schema 認出這是哪一種請求** —— 兩種任務走同一支端點。
        const wantsAngles = body.format?.properties?.['angles'] !== undefined;
        chatCalls.push({
          model: String(body.model ?? ''),
          task: wantsAngles ? 'angles' : 'extract',
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            message: { content: JSON.stringify(wantsAngles ? angles : extraction) },
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
  const oa = ollama.address();
  ollamaBase = `http://127.0.0.1:${typeof oa === 'object' && oa !== null ? oa.port : 0}`;

  sources = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }
    if (path.startsWith('/article')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(ARTICLE);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  await new Promise<void>((r) => sources.listen(0, '127.0.0.1', r));
  const sa = sources.address();
  sourcesBase = `http://127.0.0.1:${typeof sa === 'object' && sa !== null ? sa.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => ollama.close(() => r()));
  await new Promise<void>((r) => sources.close(() => r()));
});

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-expand-'));
  dataRoot = join(sandbox, 'DataRoot');
  await mkdir(join(sandbox, 'LocalAppData'), { recursive: true });
  savedLocalAppData = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'LocalAppData');

  agentScript = join(sandbox, 'fake-agent.mjs');
  await writeFile(agentScript, FAKE_AGENT, 'utf8');

  chatContextTokens = 128_000;
  extractModelContextTokens = 128_000;
  chatCalls.length = 0;
  process.env['CYCLOSA_FAKE_AGENT_MODE'] = 'ok';
  process.env['CYCLOSA_FAKE_AGENT_URLS'] = `${sourcesBase}/article`;
  extraction = { entities: [], relations: [] };
  angles = {
    angles: [
      { question: '這樁收購的金額是多少？', stance: '資金流向', seeds: [] },
      { question: '被收購的一方怎麼說？', stance: '當事人說法', seeds: [] },
    ],
  };

  await writeProvidersFile(true);
  const created = await createCase(dataRoot, { name: '合成擴展驗收' });
  if (!created.ok) throw new Error(`建不出專題：${created.code}`);
  slug = created.data.slug;
});

afterEach(async () => {
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  delete process.env['CYCLOSA_FAKE_AGENT_MODE'];
  delete process.env['CYCLOSA_FAKE_AGENT_URLS'];
  await rm(sandbox, { recursive: true, force: true });
});

// ══ 第一階段 ═══════════════════════════════════════════════

describe('產生切入角度', () => {
  it('回一份子問題清單，而且**還沒有開始抓任何東西**', async () => {
    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.data.angles).toHaveLength(2);
    expect(started.data.angles[0]?.question).toContain('金額');
    expect(started.data.angles[0]?.stance).toBe('資金流向');

    const detail = await getRun(dataRoot, slug, started.data.runId);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    // **排隊中，不是執行中** —— 中間那一步是使用者的
    expect(detail.data.run.status).toBe('queued');
    expect(detail.data.items).toHaveLength(0);
  });

  it('主題是空的回 400 的碼', async () => {
    const r = await startExpansion(dataRoot, slug, '   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SEARCH_QUERY_EMPTY');
  });

  /**
   * **這一次呼叫記在帳上，即使使用者一條都沒有勾。**
   * 「請求數是主要上限」（ADR-0006 的補記）—— 而沒有記下來的請求數是假的。
   */
  it('產生角度那一次呼叫算進請求數', async () => {
    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    if (!started.ok) return;
    const detail = await getRun(dataRoot, slug, started.data.runId);
    if (!detail.ok) return;
    expect(detail.data.run.requests).toBe(1);
    // 本機模型的金額成本**真的是 0**，那是事實不是「不知道」
    expect(detail.data.run.costUsd).toBe(0);
  });

  /**
   * **抓失敗的那些不是「你已經有的東西」。**
   *
   * 它們的 `title` 就是那個網址，正文一個字都沒有 ——
   * 拿去歸納視角等於給模型一串沒有內容的 URL，
   * 而畫面上會寫「依據：https://…」，指著一份使用者根本讀不到的東西。
   *
   * 2026-09-08 第一次真的跑完一次擴展時，6 份裡有 5 份是付費牆，
   * 而它們全部被當成了種子。
   */
  it('抓失敗的資料節點不會被當成種子', async () => {
    process.env['CYCLOSA_FAKE_AGENT_URLS'] = `${sourcesBase}/article,${sourcesBase}/missing`;
    const first = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    if (!first.ok) return;
    // 空專題，所以第一次沒有種子
    expect(first.data.seededFrom).toBe(0);
    const chosen = await chooseAngles(dataRoot, slug, first.data.runId, [
      first.data.angles[0]?.id as string,
    ]);
    expect(chosen.ok).toBe(true);
    await waitForRun(first.data.runId);

    // 兩個網址：一個成功、一個 404
    const detail = await getRun(dataRoot, slug, first.data.runId);
    if (!detail.ok) return;
    expect(detail.data.items).toHaveLength(2);
    expect(detail.data.items.filter((i) => i.outcome === 'failed')).toHaveLength(1);

    // **第二次擴展的種子只有那一份成功的**
    const second = await startExpansion(dataRoot, slug, '再問一次');
    if (!second.ok) return;
    expect(second.data.seededFrom).toBe(1);
  });

  it('沒被勾的角度也留著 —— 作業紀錄要看得出當時有哪些選項', async () => {
    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    if (!started.ok) return;
    const chosen = await chooseAngles(dataRoot, slug, started.data.runId, [
      started.data.angles[0]?.id as string,
    ]);
    expect(chosen.ok).toBe(true);
    if (chosen.ok) await waitForRun(started.data.runId);

    const detail = await getRun(dataRoot, slug, started.data.runId);
    if (!detail.ok) return;
    expect(detail.data.angles).toHaveLength(2);
    expect(detail.data.angles.filter((a) => a.selected)).toHaveLength(1);
  });
});

// ══ 配不上就停手 ═══════════════════════════════════════════

describe('provider 配不上就停手，不靜默降級（ADR-0006）', () => {
  it('沒設定 chat → PROVIDER_NOT_CONFIGURED', async () => {
    await writeFile(
      join(sandbox, 'LocalAppData', 'Cyclosa', 'providers.json'),
      JSON.stringify({ version: 1, chat: { baseUrl: ollamaBase, model: '' }, agent: null }),
      'utf8',
    );
    const r = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('Ollama 關掉了 → PROVIDER_UNREACHABLE，而且說得出打不到哪裡', async () => {
    await writeFile(
      join(sandbox, 'LocalAppData', 'Cyclosa', 'providers.json'),
      JSON.stringify({
        version: 1,
        chat: { baseUrl: 'http://127.0.0.1:1', model: 'fake-model' },
        agent: null,
      }),
      'utf8',
    );
    const r = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('PROVIDER_UNREACHABLE');
      expect(String(r.detail?.['at'])).toContain('127.0.0.1:1');
    }
  });

  /** **缺哪幾樣要帶出去** —— 只說「配不上」的話，使用者不知道要改什麼。 */
  it('context 太小 → PROVIDER_CAPABILITY_MISSING，而且 detail 說得出缺什麼', async () => {
    chatContextTokens = 2048;
    const r = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('PROVIDER_CAPABILITY_MISSING');
      expect(r.detail?.['role']).toBe('chat');
    }
  });

  /**
   * **這一條守的是 2026-09-09 修掉的那個缺口。**
   *
   * `TASK_ANGLES` 只要 8000 context，而抽取那一步要吃 12,000 字的外部正文
   * （`TASK_EXTRACT` 的門檻見那個常數）。在補上 `TASK_EXTRACT` 之前，一個 10000 context
   * 的模型會**一路通過**：角度那一關過、勾選那一關只檢查 chat「有沒有設定」，
   * 然後把全部網址抓完，最後在每一份文件上把正文截掉一半 ——
   * 而抽出來的關聯照樣帶引文、照樣進待查證，畫面上看不出任何異常。
   */
  it('context 過得了角度但不夠抽取 → 勾選就停手，**一個網址都沒抓**', async () => {
    chatContextTokens = 10_000;
    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    // 角度那一關本來就該過 —— 它只要 8000。
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const chosen = await chooseAngles(dataRoot, slug, started.data.runId, [
      started.data.angles[0]?.id as string,
    ]);
    expect(chosen.ok).toBe(false);
    if (!chosen.ok) {
      expect(chosen.code).toBe('PROVIDER_CAPABILITY_MISSING');
      expect(chosen.detail?.['role']).toBe('chat');
      // **旗標是空的，缺的是 context** —— 所以那兩個數字一定要帶出去，
      // 否則畫面上只會顯示「缺少：（空白）」。
      // **引用常數本身，不要抄一份數字。** 2026-09-09 這裡寫死 18000，
      // 而門檻改成 24000 的時候是這條測試紅了才發現 —— 那次它抓對了，
      // 但下一次改的人得同時記得改兩個地方，而那正是會漂的形狀。
      expect(chosen.detail?.['needContextTokens']).toBe(TASK_EXTRACT.minContextTokens);
      expect(chosen.detail?.['haveContextTokens']).toBe(10_000);
    }

    const detail = await getRun(dataRoot, slug, started.data.runId);
    if (!detail.ok) return;
    expect(detail.data.items).toHaveLength(0);
  });

  it('沒設定 agent → 勾選那一步就停手，而且**一個網址都沒抓**', async () => {
    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    if (!started.ok) return;
    await writeProvidersFile(false);

    const chosen = await chooseAngles(dataRoot, slug, started.data.runId, [
      started.data.angles[0]?.id as string,
    ]);
    expect(chosen.ok).toBe(false);
    if (!chosen.ok) expect(chosen.code).toBe('PROVIDER_NOT_CONFIGURED');

    const detail = await getRun(dataRoot, slug, started.data.runId);
    if (!detail.ok) return;
    expect(detail.data.items).toHaveLength(0);
  });
});

// ══ 第二階段：真的跑 ═══════════════════════════════════════

describe('勾選之後才真的開始', () => {
  async function runOne(): Promise<string> {
    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    if (!started.ok) throw new Error(`開不了擴展：${started.code}`);
    const chosen = await chooseAngles(dataRoot, slug, started.data.runId, [
      started.data.angles[0]?.id as string,
    ]);
    if (!chosen.ok) throw new Error(`勾不了角度：${chosen.code}`);
    await waitForRun(started.data.runId);
    return started.data.runId;
  }

  it('agent 找到的網址走**同一條擷取管線**，新節點帶著出處進來', async () => {
    extraction = {
      entities: [
        { name: '合成公司', type: 'org' },
        { name: '合成工作室', type: 'org' },
      ],
      relations: [{ subject: '合成公司', rel: '收購', object: '合成工作室', quote: QUOTE }],
    };

    const runId = await runOne();
    const detail = await getRun(dataRoot, slug, runId);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    expect(detail.data.run.status).toBe('done');
    expect(detail.data.items).toHaveLength(1);
    expect(detail.data.items[0]?.outcome).toBe('ok');

    const rows = await inDb((db) => ({
      entities: db.prepare('SELECT name_zh FROM entity ORDER BY name_zh').all() as {
        name_zh: string;
      }[],
      named: db.prepare("SELECT * FROM edge WHERE layer='named'").all() as Record<
        string,
        unknown
      >[],
      comention: db.prepare("SELECT COUNT(*) n FROM edge WHERE layer='comention'").get() as {
        n: number;
      },
      evidence: db.prepare('SELECT * FROM edge_evidence').all() as Record<string, unknown>[],
      items: db.prepare('SELECT id, title FROM item').all() as { id: string; title: string }[],
    }));

    expect(rows.entities.map((e) => e.name_zh)).toEqual(['合成公司', '合成工作室']);
    // 兩條共同提及（這一份提到兩個實體）
    expect(rows.comention.n).toBe(2);
    expect(rows.named).toHaveLength(1);
    expect(rows.named[0]?.['rel']).toBe('收購');
    // **機器抽的邊一律進待查證** —— 沒有任何一條路通往「自動確認」
    expect(rows.named[0]?.['status']).toBe('pending');
    expect(rows.named[0]?.['origin']).toBe('machine');

    // 出處的字元區間**指得回原文**
    expect(rows.evidence).toHaveLength(1);
    const ev = rows.evidence[0] as { item_id: string; char_start: number; char_end: number };
    const derived = JSON.parse(
      await readFile(join(dataRoot, 'cases', slug, 'derived', `${ev.item_id}.v1.json`), 'utf8'),
    ) as { text: string };
    expect(derived.text.slice(ev.char_start, ev.char_end)).toBe(QUOTE);
  });

  /**
   * **這是整個 v0.5.0 最重要的一條。**
   *
   * 模型編一句原文沒有的話出來，那條關聯就不該存在 ——
   * 一個指不到原文的出處，比沒有出處更糟，因為它看起來已經被驗過了。
   */
  it('引文在原文裡找不到 → 那條關聯不寫進去，而且說得出來', async () => {
    extraction = {
      entities: [
        { name: '合成公司', type: 'org' },
        { name: '合成工作室', type: 'org' },
      ],
      relations: [
        { subject: '合成公司', rel: '收購', object: '合成工作室', quote: QUOTE },
        {
          subject: '合成公司',
          rel: '解散',
          object: '合成工作室',
          quote: '合成公司在三月宣布解散董事會，而這句話原文裡沒有。',
        },
      ],
    };

    const runId = await runOne();
    const named = await inDb(
      (db) => db.prepare("SELECT rel FROM edge WHERE layer='named'").all() as { rel: string }[],
    );
    // **只有找得到引文的那一條進去了**
    expect(named.map((r) => r.rel)).toEqual(['收購']);

    const detail = await getRun(dataRoot, slug, runId);
    if (!detail.ok) return;
    expect(detail.data.angles.find((a) => a.selected)?.code).toBe('PROVIDER_QUOTE_NOT_FOUND');

    /**
     * **這條作業是「部分失敗」，不是「失敗」。**
     *
     * 它抽掉了一條引文對不上的關係，但另一條寫進去了 ——
     * 而 2026-09-08 第一次真的跑一次擴展時，這裡標的是 `失敗`，
     * 同時畫面上列著它寫進去的 1 個節點與 9 條關聯。
     * **「部分失敗被併進失敗」是這個專案明寫要避免的那條。**
     */
    expect(detail.data.run.status).toBe('partial');
    expect(detail.data.run.succeeded).toBe(1);
    expect(detail.data.run.failed).toBe(0);
  });

  it('模型冒出一個沒宣告過的實體名 → 那條關係丟掉，不新增節點', async () => {
    extraction = {
      entities: [{ name: '合成公司', type: 'org' }],
      relations: [{ subject: '合成公司', rel: '收購', object: '沒有宣告過的公司', quote: QUOTE }],
    };
    await runOne();
    const rows = await inDb((db) => ({
      entities: db.prepare('SELECT COUNT(*) n FROM entity').get() as { n: number },
      named: db.prepare("SELECT COUNT(*) n FROM edge WHERE layer='named'").get() as { n: number },
    }));
    expect(rows.entities.n).toBe(1);
    expect(rows.named.n).toBe(0);
  });

  it('agent 失敗 → 那條角度帶自己的碼，run 是失敗但已寫入的保留', async () => {
    process.env['CYCLOSA_FAKE_AGENT_MODE'] = 'fail';
    const runId = await runOne();
    const detail = await getRun(dataRoot, slug, runId);
    if (!detail.ok) return;
    expect(detail.data.run.status).toBe('failed');
    expect(detail.data.angles.find((a) => a.selected)?.code).toBe('PROVIDER_BUDGET_EXCEEDED');
    // **provider 回報的金額有被記下來**
    expect(detail.data.run.costUsd).toBeCloseTo(0.18);
  });

  it('同一個 run 不能勾第二次', async () => {
    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    if (!started.ok) return;
    const id = started.data.angles[0]?.id as string;
    const first = await chooseAngles(dataRoot, slug, started.data.runId, [id]);
    expect(first.ok).toBe(true);
    await waitForRun(started.data.runId);
    const second = await chooseAngles(dataRoot, slug, started.data.runId, [id]);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('GRAPH_TRANSITION_INVALID');
  });

  it('一條都沒勾就送出會被擋下來', async () => {
    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    if (!started.ok) return;
    const r = await chooseAngles(dataRoot, slug, started.data.runId, []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('EXPORT_EMPTY_SELECTION');
  });
});

// ══ 沙箱（Phase F 的驗收條件）═══════════════════════════════

/**
 * **逐任務覆寫**（2026-09-10）。
 *
 * 量測的結論是「兩件事的最好解不是同一個模型」（`docs/research/chat-choice.md`
 * 發現六），而這一組守的是那個結論被接上去之後**真的分開跑了**。
 *
 * 這裡不能用 mock 檢查 —— 覆寫失效的方式是**安靜地用預設模型跑完**，
 * 結果一樣、畫面一樣、碼一樣。唯一看得出來的地方是**送出去的請求裡的 `model`**，
 * 所以假 Ollama 記下每一次呼叫用了哪個模型，而斷言看的是那份紀錄。
 */
describe('chat 的逐任務覆寫', () => {
  it('抽取覆寫到另一個模型 → 兩次呼叫真的送到不同的模型', async () => {
    await writeProvidersFile(true, { angles: '', extract: 'fake-extract-model' });
    extraction = {
      entities: [
        { name: '合成公司', type: 'org' },
        { name: '合成工作室', type: 'org' },
      ],
      relations: [{ subject: '合成公司', rel: '收購', object: '合成工作室', quote: QUOTE }],
    };

    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const chosen = await chooseAngles(dataRoot, slug, started.data.runId, [
      started.data.angles[0]?.id as string,
    ]);
    expect(chosen.ok).toBe(true);
    await waitForRun(started.data.runId);

    // **兩種任務各自跑在自己的模型上。** 少了 `chatFor` 的話這兩行會是同一個名字。
    expect(chatCalls.filter((c) => c.task === 'angles').map((c) => c.model)).toEqual([
      'fake-model',
    ]);
    expect(chatCalls.filter((c) => c.task === 'extract').map((c) => c.model)).toEqual([
      'fake-extract-model',
    ]);

    // 作業紀錄要記得住**兩個**：換模型重跑結果會不一樣，而生出關聯的是後面那一個。
    const detail = await getRun(dataRoot, slug, started.data.runId);
    expect(detail.ok).toBe(true);
    if (!detail.ok) return;
    const used = JSON.parse(detail.data.run.providers ?? '{}') as Record<string, unknown>;
    expect(used['chat']).toBe('ollama:fake-model');
    expect(used['chatExtract']).toBe('ollama:fake-extract-model');
    /**
     * **格式保證也記下來，兩個任務各一個**。抽取那一個是第二階段才確定的 ——
     * 第一階段寫進去的時候它還是 `null`，這一條確認它被補寫了。
     * 本機 Ollama 兩邊都是 `schema`（原生 `format` 是受限解碼）。
     */
    expect(used['json']).toEqual({ angles: 'schema', extract: 'schema' });
  });

  /**
   * **這一條是逐任務覆寫真正的風險。**
   *
   * 閘門只看預設模型的話，把抽取覆寫到一個 context 不夠的模型上會**一路通過**：
   * 設定頁上那一格顯示的是預設模型（128k，綠的），而實際跑的那一個只有 10,000 ——
   * 於是正文被截掉一半，抽出來的關聯照樣帶引文、照樣進待查證。
   *
   * 跟 2026-09-09 修掉的那個缺口是同一種形狀，只是這一次「被檢查的東西」
   * 與「實際跑的東西」不是差在任務，是差在**模型**。
   */
  it('覆寫到 context 不夠的模型 → 勾選就停手，**一個網址都沒抓**', async () => {
    // 預設模型完全夠用，不夠的只有被覆寫過去的那一個。
    chatContextTokens = 128_000;
    extractModelContextTokens = 10_000;
    await writeProvidersFile(true, { angles: '', extract: 'fake-extract-model' });

    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    // 角度跑在預設模型上，那一關本來就該過。
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const chosen = await chooseAngles(dataRoot, slug, started.data.runId, [
      started.data.angles[0]?.id as string,
    ]);
    expect(chosen.ok).toBe(false);
    if (!chosen.ok) {
      expect(chosen.code).toBe('PROVIDER_CAPABILITY_MISSING');
      expect(chosen.detail?.['role']).toBe('chat');
      expect(chosen.detail?.['needContextTokens']).toBe(TASK_EXTRACT.minContextTokens);
      // **10,000 是覆寫那個模型的數字**，不是預設模型的 128,000。
      expect(chosen.detail?.['haveContextTokens']).toBe(10_000);
    }

    const detail = await getRun(dataRoot, slug, started.data.runId);
    if (!detail.ok) return;
    expect(detail.data.items).toHaveLength(0);
  });

  it('沒有覆寫 → 兩件事都跑在預設模型上，作業紀錄不記第二個', async () => {
    extraction = { entities: [{ name: '合成公司', type: 'org' }], relations: [] };
    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    if (!started.ok) return;
    const chosen = await chooseAngles(dataRoot, slug, started.data.runId, [
      started.data.angles[0]?.id as string,
    ]);
    expect(chosen.ok).toBe(true);
    await waitForRun(started.data.runId);

    expect(new Set(chatCalls.map((c) => c.model))).toEqual(new Set(['fake-model']));
    const detail = await getRun(dataRoot, slug, started.data.runId);
    if (!detail.ok) return;
    const used = JSON.parse(detail.data.run.providers ?? '{}') as Record<string, unknown>;
    // **相同就不寫第二次** —— 「A ＋ A」在作業紀錄那一行讀起來像兩個東西。
    expect(used['chatExtract']).toBeNull();
  });
});

describe('agent 的沙箱', () => {
  it('跑完之後沙箱裡**沒有任何抓取產物**', async () => {
    extraction = { entities: [], relations: [] };
    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    if (!started.ok) return;
    await chooseAngles(dataRoot, slug, started.data.runId, [started.data.angles[0]?.id as string]);
    await waitForRun(started.data.runId);

    const { readdir } = await import('node:fs/promises');
    const root = join(dataRoot, 'cases', slug, 'agent', 'runs', started.data.runId);
    const entries = await readdir(root, { recursive: true, withFileTypes: true });
    expect(entries.filter((e) => e.isFile())).toEqual([]);
  });

  /**
   * 真實的 `claude` 是拿不到寫檔工具的（`--tools WebSearch`），
   * **而這條測試假設那一層失效了** —— 參數會被改版、被忽略、被拼錯。
   */
  it('沙箱裡出現 HTML → 整批停下來，碼是 PROVIDER_SANDBOX_VIOLATION', async () => {
    process.env['CYCLOSA_FAKE_AGENT_MODE'] = 'sandbox';
    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    if (!started.ok) return;
    await chooseAngles(dataRoot, slug, started.data.runId, [started.data.angles[0]?.id as string]);
    await waitForRun(started.data.runId);

    const detail = await getRun(dataRoot, slug, started.data.runId);
    if (!detail.ok) return;
    expect(detail.data.run.errorCode).toBe('PROVIDER_SANDBOX_VIOLATION');
    expect(detail.data.run.status).toBe('failed');
    // **一個網址都沒抓** —— 停下來就是停下來
    expect(detail.data.items).toHaveLength(0);
  });
});

// ══ 擴展不得覆寫人工判定（Phase E 的驗收條件）══════════════

describe('擴展前後，人的判斷一個都沒有變', () => {
  async function expand(): Promise<void> {
    const started = await startExpansion(dataRoot, slug, '一樁合成的收購案');
    if (!started.ok) throw new Error(started.code);
    const chosen = await chooseAngles(dataRoot, slug, started.data.runId, [
      started.data.angles[0]?.id as string,
    ]);
    if (!chosen.ok) throw new Error(chosen.code);
    await waitForRun(started.data.runId);
  }

  function humanRows(db: DatabaseSync): unknown {
    return db
      .prepare(
        `SELECT id, layer, rel, source_id, target_id, origin, status, confidence
           FROM edge WHERE origin='human' ORDER BY id`,
      )
      .all();
  }

  it('`origin=human` 的子集 diff 必須為空', async () => {
    extraction = {
      entities: [
        { name: '合成公司', type: 'org' },
        { name: '合成工作室', type: 'org' },
      ],
      relations: [{ subject: '合成公司', rel: '收購', object: '合成工作室', quote: QUOTE }],
    };
    // 先跑一次拿到兩個實體，再手動連一條它們之間的邊
    await expand();
    const ids = await inDb(
      (db) => db.prepare('SELECT id FROM entity ORDER BY name_zh').all() as { id: string }[],
    );
    const made = await createEdge(dataRoot, slug, {
      source: ids[0]?.id as string,
      target: ids[1]?.id as string,
      rel: '我自己連的關係',
      layer: 'named',
    });
    expect(made.ok).toBe(true);

    const before = await inDb(humanRows);
    await expand();
    const after = await inDb(humanRows);
    expect(after).toEqual(before);
  });

  /** 否決過的組合重跑不再出現（墓碑，ADR-0016）。 */
  it('否決過的組合重跑不再出現，出處也不會偷偷變多', async () => {
    extraction = {
      entities: [
        { name: '合成公司', type: 'org' },
        { name: '合成工作室', type: 'org' },
      ],
      relations: [{ subject: '合成公司', rel: '收購', object: '合成工作室', quote: QUOTE }],
    };
    await expand();

    const edgeId = await inDb(
      (db) => (db.prepare("SELECT id FROM edge WHERE layer='named'").get() as { id: string }).id,
    );
    const rejected = await transitionEdge(dataRoot, slug, edgeId, 'reject');
    expect(rejected.ok).toBe(true);

    // **重跑：同一份文件、同一句引文** —— 沒有新出處，所以墓碑擋下來
    await expand();

    const after = await inDb((db) => ({
      status: (
        db.prepare('SELECT status FROM edge WHERE id = ?').get(edgeId) as {
          status: string;
        }
      ).status,
      evidence: (
        db.prepare('SELECT COUNT(*) n FROM edge_evidence WHERE edge_id = ?').get(edgeId) as {
          n: number;
        }
      ).n,
    }));
    expect(after.status).toBe('rejected');
    expect(after.evidence).toBe(1);
  });
});
