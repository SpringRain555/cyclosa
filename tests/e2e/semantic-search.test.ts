/**
 * 語意檢索的端對端測試。
 *
 * ## 假的只有嵌入端點
 *
 * 一台起在 `127.0.0.1` 的假 Ollama 回 `/api/embed`。**其餘全部是真的** ——
 * `providers.json` 真的被讀、切段走 `domain/search/chunk.ts`、
 * 向量真的以 BLOB 寫進 SQLite、比對真的逐批讀出來算點積、
 * 排序真的走 `interleave` ＋ `rankHits`。
 *
 * ## 假向量怎麼構造，以及為什麼可以這樣
 *
 * 這一份**不是在測嵌入模型好不好**（那是 `research/embedding-choice.md`
 * 量過的事：七個候選、1955 段、50 條查詢）。它測的是**接線**：
 * 「一份用字完全不同的文件，能不能因為向量相近而被找到」。
 *
 * 所以假端點用一個**確定性的規則**產生向量：文字裡出現哪幾個關鍵詞，
 * 就在對應的維度上加值。這讓「語意相近」變成一件測試控制得住的事 ——
 * 而**真正的模型能不能做到這件事，是另一份文件回答的問題。**
 */
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createCase } from '../../src/application/case-service.js';
import { importFile } from '../../src/application/ingest-service.js';
import { backfillVectors } from '../../src/application/embed-service.js';
import { searchCase } from '../../src/application/search-service.js';
import { embedPrefixesFor } from '../../src/domain/search/embed-prefix.js';

/**
 * 假向量的「概念」維度。
 *
 * 前兩個是同一件事的兩種說法（**沒有共同的字**），第三個是別的主題。
 * 這一組就是這份測試要證明的東西：**字面不重疊，向量重疊。**
 */
const CONCEPTS: readonly (readonly string[])[] = [
  ['結網', '蛛網', '織巢', 'web-building'], // 概念 0
  ['演化', '天擇', '適應', 'evolution'], // 概念 1
  ['颱風', '氣旋', '風暴', 'cyclone'], // 概念 2
];

/** 文字 → 向量。**確定性的**，見檔頭。 */
function fakeVector(text: string): number[] {
  const v = CONCEPTS.map((words) => words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0));
  // 全零的話所有東西都一樣像 —— 給一個很小的底，讓排序仍然是確定的。
  return v.every((n) => n === 0) ? CONCEPTS.map(() => 0.01) : v;
}

/** 每一次 `/api/embed` 收到什麼。**前綴有沒有加，只看得到這裡。** */
const embedCalls: { model: string; inputs: string[] }[] = [];

let ollama: Server;
let ollamaBase = '';
let sandbox = '';
let dataRoot = '';
let slug = '';
let savedLocalAppData: string | undefined;
let spiderId = '';
let cycloneId = '';

/**
 * 一份中文文件，講的是蜘蛛結網的演化。
 *
 * **每一行都要超過 120 個字元**（`CHUNK_CJK.min`），否則它會被當成標題丟掉。
 */
const ARTICLE = [
  '蛛形綱的結網行為在化石紀錄裡出現得很早，而那個時間點本身就是一條線索。這一段刻意寫得夠長，',
  '因為切段的門檻是一百二十個字元，低於門檻的行會被當成章節標題或殘留而丟掉，那樣就測不到切段了。',
  '所以這裡再補上兩句話，讓整段穩穩地超過那個數字，測試量到的才是接線本身而不是門檻。',
].join('');
const ARTICLE2 = [
  '熱帶氣旋的生成需要足夠溫暖的海水與適當的垂直風切，兩者缺一不可。這一段同樣寫得夠長，',
  '好讓它穩穩地超過切段的最小長度，成為一個獨立的段落，而不是被併進前一段或整個丟掉。',
  '再補一句把長度推過去，順便讓這一段讀起來仍然像一段真的文字而不是一串填充字元。',
].join('');

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString('utf8');
    });
    req.on('end', () => resolve(raw));
  });
}

async function writeProvidersFile(model: string | null): Promise<void> {
  const dir = join(sandbox, 'LocalAppData', 'Cyclosa');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'providers.json'),
    JSON.stringify({
      version: 1,
      chat: null,
      agent: null,
      embed: { baseUrl: ollamaBase, model: model ?? '' },
    }),
    'utf8',
  );
}

beforeAll(async () => {
  ollama = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (path === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'fake-embed', details: {} }] }));
      return;
    }
    if (path === '/api/embed') {
      void readBody(req).then((raw) => {
        const body = JSON.parse(raw) as { model?: unknown; input?: unknown };
        const inputs = Array.isArray(body.input) ? (body.input as string[]) : [];
        embedCalls.push({ model: String(body.model ?? ''), inputs });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ embeddings: inputs.map((t) => fakeVector(t)) }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
  const a = ollama.address();
  ollamaBase = `http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`;
});

afterAll(async () => {
  await new Promise<void>((r) => ollama.close(() => r()));
});

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-embed-'));
  dataRoot = join(sandbox, 'DataRoot');
  await mkdir(join(sandbox, 'LocalAppData'), { recursive: true });
  savedLocalAppData = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'LocalAppData');
  embedCalls.length = 0;

  await writeProvidersFile('fake-embed');
  const created = await createCase(dataRoot, { name: '語意檢索驗收' });
  if (!created.ok) throw new Error(`建不了專題：${created.code}`);
  slug = created.data.slug;

  // 兩份純文字，直接走匯入管線（不需要網路）。
  // **記下 id** —— 標題是抽取器決定的，拿它當斷言等於在測另一件事。
  spiderId = '';
  cycloneId = '';
  for (const [name, body] of [
    ['蜘蛛.txt', ARTICLE],
    ['氣旋.txt', ARTICLE2],
  ] as const) {
    const r = await importFile(dataRoot, slug, name, new TextEncoder().encode(body));
    if (!r.ok) throw new Error(`匯入失敗：${r.code}`);
    if (r.data.itemId === null) throw new Error(`匯入沒有產生節點：${name}`);
    if (name === '蜘蛛.txt') spiderId = r.data.itemId;
    else cycloneId = r.data.itemId;
  }
});

afterEach(async () => {
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  await rm(sandbox, { recursive: true, force: true });
});

describe('匯入時就寫向量', () => {
  it('匯入完就已經有向量 —— 回填沒有東西可做', async () => {
    const r = await backfillVectors(dataRoot, slug);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // **匯入那一步已經寫過了**，所以這裡 `remaining` 是 0、`processed` 也是 0。
    expect(r.data.remaining).toBe(0);
    expect(r.data.processed).toBe(0);
    expect(r.data.owners).toBe(2);
    expect(r.data.rows).toBeGreaterThanOrEqual(2);
  });

  /**
   * **文件那一側不加前綴，查詢那一側要加。**
   *
   * 這一條守的是一個不會報錯的錯：少加前綴不會失敗，
   * 只會讓命中率安靜地變低（`research/embedding-choice.md`）。
   */
  it('文件那一側送出去的是原文，沒有前綴', () => {
    expect(embedCalls.length).toBeGreaterThan(0);
    for (const call of embedCalls) {
      for (const input of call.inputs) {
        expect(input.startsWith('Instruct:')).toBe(false);
      }
    }
  });

  it('前綴照表加，認不得的模型不加而且說它沒查證過 —— **不知道就不動手**', () => {
    // card 上的字一個都不改：qwen 的 `Query:` 後面沒有空白，e5-instruct 的有。
    expect(embedPrefixesFor('qwen3-embedding:4b').query.endsWith('\nQuery:')).toBe(true);
    const e5 = embedPrefixesFor('hf.co/Ralriki/multilingual-e5-large-instruct-GGUF:F16');
    expect(e5.query.endsWith('\nQuery: ')).toBe(true);
    expect(e5.document).toBe('');
    expect(embedPrefixesFor('hf.co/nomic-ai/nomic-embed-text-v2-moe-GGUF:F16').document).toBe(
      'search_document: ',
    );
    const granite = embedPrefixesFor(
      'hf.co/mykor/granite-embedding-311m-multilingual-r2-GGUF:BF16',
    );
    expect(granite).toMatchObject({ query: '', document: '', verified: true });
    expect(embedPrefixesFor('fake-embed')).toMatchObject({
      query: '',
      document: '',
      verified: false,
    });
  });
});

describe('語意檢索找得到用字不同的那一份', () => {
  /**
   * **這是整個 v0.11.0最重要的一條。**
   *
   * 查詢用的字在正文裡一個都沒有出現（「織巢」「天擇」對「結網」「演化」），
   * 所以全文檢索**必然**找不到它 —— 而語意那一路要找得到。
   * 兩件事一起成立，這個功能才有存在的理由。
   */
  it('全文找不到、語意找得到', async () => {
    const q = '織巢與天擇';

    const text = await searchCase(dataRoot, slug, { q, mode: 'text' });
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    // 字面上一個都沒有 —— 這是對照組，它證明查詢真的沒有字面線索。
    expect(text.data.hits.filter((h) => h.check === 'hit')).toHaveLength(0);

    const semantic = await searchCase(dataRoot, slug, { q, mode: 'semantic' });
    expect(semantic.ok).toBe(true);
    if (!semantic.ok) return;
    expect(semantic.data.notices).not.toContain('SEARCH_EMBED_UNAVAILABLE');
    const ids = semantic.data.hits.map((h) => h.id);
    expect(ids).toContain(spiderId);
    // **而且它排在氣旋那一份前面** —— 兩份都會拿到一個分數，
    // 差別在哪一份的向量比較近。只斷言「找得到」的話，
    // 一個把全部文件都回傳的實作也會通過。
    expect(ids.indexOf(spiderId)).toBeLessThan(
      ids.indexOf(cycloneId) === -1 ? Number.MAX_SAFE_INTEGER : ids.indexOf(cycloneId),
    );
  });

  /**
   * **語意命中不能被標成「可能是誤中」。**
   *
   * 正文裡沒有那串字是它的用途，不是它的缺陷 —— 而在加第四種狀態之前，
   * `checkText` 會回 `miss`，畫面上寫的是「可能是誤中：正文裡沒有這串字」。
   * **對一個正確的結果指控它是誤中。**
   */
  it('語意命中標成 `semantic`，而且摘要是真正命中的那一段', async () => {
    const r = await searchCase(dataRoot, slug, { q: '織巢與天擇', mode: 'semantic' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hit = r.data.hits.find((h) => h.id === spiderId);
    expect(hit).toBeDefined();
    expect(hit?.check).toBe('semantic');
    // 摘要是那一段本身，所以它帶著正文裡真的有的字。
    expect(hit?.snippet).toContain('結網');
  });

  it('查詢那一側的前綴真的送出去了', async () => {
    embedCalls.length = 0;
    await searchCase(dataRoot, slug, { q: '織巢與天擇', mode: 'semantic' });
    // 這個假模型不叫 qwen3-embedding，所以不該加前綴 —— 而它送出去的
    // 應該就是查詢本身。**這一條釘的是「查詢有走 embedQuery」**。
    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]?.inputs).toEqual(['織巢與天擇']);
  });

  it('`hybrid` 兩路都跑：字面命中的那一份仍然是 `hit`', async () => {
    const r = await searchCase(dataRoot, slug, { q: '結網', mode: 'hybrid' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const hit = r.data.hits.find((h) => h.id === spiderId);
    // **字面找得到就標 `hit`** —— 那是更強的證據，不該被語意蓋掉。
    expect(hit?.check).toBe('hit');
  });
});

describe('沒有嵌入模型時不假裝有', () => {
  it('要求語意 → 全文照常回，而且 notice 說出來', async () => {
    await writeProvidersFile(null);
    const r = await searchCase(dataRoot, slug, { q: '結網', mode: 'semantic' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // **不是錯誤**：降級可以，安靜不行（ADR-0006 第 3 條）。
    expect(r.data.notices).toContain('SEARCH_EMBED_UNAVAILABLE');
  });

  it('回填在沒設定模型時回一份說得出「零」的報告，不是錯誤', async () => {
    await writeProvidersFile(null);
    const r = await backfillVectors(dataRoot, slug);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.model).toBeNull();
    expect(r.data.processed).toBe(0);
    // 舊模型的向量**留著**，而且說得出來 —— 換模型的時候這一欄是唯一的線索。
    expect(r.data.otherModels.some((m) => m.model === 'fake-embed')).toBe(true);
  });

  it('`text` 模式完全不碰嵌入端點', async () => {
    embedCalls.length = 0;
    await searchCase(dataRoot, slug, { q: '結網', mode: 'text' });
    expect(embedCalls).toHaveLength(0);
  });
});
