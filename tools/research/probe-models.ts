/**
 * 探針：把候選嵌入模型的**可查證欄位**一次拉齊。
 *
 * 三個來源，三種不同的東西：
 *
 * | 來源 | 拿到什麼 | 為什麼是這一個 |
 * |---|---|---|
 * | `huggingface.co/api/models/<repo>` | 授權、最後更新、下載數 | **模型自己宣告的欄位**，不是第三方轉述 |
 * | 同上 `?blobs=true` 的 `siblings` | 有沒有 GGUF | 決定「Ollama 拉不拉得到」的**硬條件** |
 * | `registry.ollama.ai/v2/.../manifests/<tag>` | 下載大小（各層相加） | 使用者實際要下載的位元組 |
 *
 * **走的是真的擷取管線**（`Crawler`）—— 節流、robots、429 立即停都跟匯入同一條路。
 *
 * 用法：
 *   npx tsx tools/research/probe-models.ts            # 跑內建那一批
 *   npx tsx tools/research/probe-models.ts hf:<repo>  # 只查某一個
 *   npx tsx tools/research/probe-models.ts ollama-tags:<name>  # ollama.com 上這個模型有哪些 tag
 *   npx tsx tools/research/probe-models.ts hf-search:<作者>:<字>  # 先找到正確的 repo 名
 *
 * 每一次請求都會**接一列進 `docs/research/sources/manifest.jsonl`**。
 *
 * **`base_model` 要一起看**（2026-09-29 起）：建議值只從非中國來源的模型挑，而**底座或蒸餾來源是中國模型的也算**
 * （ADR-0035）。發布者是哪一家只回答了一半 —— `snowflake-arctic-embed2` 跟 `bge-m3` 架構、參數完全一致，
 * 就是那一半的反例。`cardData.base_model` 是模型作者自己宣告的欄位（A 級）；**沒宣告不等於沒有底座**，要去讀 card。
 */
import { appendFile } from 'node:fs/promises';

import { Crawler } from '../../src/infrastructure/fetch/crawler.js';
import { sha256Of } from '../../src/infrastructure/fs/case-files.js';

const MANIFEST = 'docs/research/sources/manifest.jsonl';
const crawler = new Crawler({ intervalMs: 4_000 });

/** 抓一個 URL，記一列 manifest，回傳解析後的 JSON（失敗回錯誤碼）。 */
async function getJson(
  url: string,
): Promise<{ ok: true; body: unknown } | { ok: false; why: string }> {
  const { outcome } = await crawler.fetch(url);
  if (outcome.kind !== 'ok') {
    await appendFile(
      MANIFEST,
      `${JSON.stringify({
        url,
        fetched_at: new Date().toISOString(),
        status: null,
        error: outcome.code,
        detail: outcome.detail,
      })}\n`,
      'utf8',
    );
    return { ok: false, why: `${outcome.code} ${JSON.stringify(outcome.detail)}` };
  }
  await appendFile(
    MANIFEST,
    `${JSON.stringify({
      url,
      fetched_at: new Date().toISOString(),
      status: outcome.status,
      content_type: outcome.contentType,
      sha256: sha256Of(outcome.bytes),
      bytes: outcome.bytes.byteLength,
    })}\n`,
    'utf8',
  );
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(outcome.bytes)) };
  } catch (err) {
    return { ok: false, why: `not-json: ${String(err)}` };
  }
}

interface Rec {
  readonly [k: string]: unknown;
}

function asRec(v: unknown): Rec {
  return typeof v === 'object' && v !== null ? (v as Rec) : {};
}

/** HF 的候選：repo 名 → 我們要的四件事。 */
const HF_REPOS: readonly string[] = [
  'intfloat/multilingual-e5-large-instruct',
  'intfloat/multilingual-e5-base',
  'Alibaba-NLP/gte-multilingual-base',
  'ibm-granite/granite-embedding-278m-multilingual',
  // **mpnet 不是 MiniLM。** Ollama 的 `paraphrase-multilingual` 底下裝的是前者
  // （277.45M 參數、768 維、`num_ctx 128`），而同名家族裡最有名的是後者。
  // 拿錯 card 的話前綴、維度、上下文三個答案都會錯，見 `docs/lessons.md`。
  'sentence-transformers/paraphrase-multilingual-mpnet-base-v2',
  'BAAI/bge-m3',
  'Qwen/Qwen3-Embedding-0.6B',
  'Snowflake/snowflake-arctic-embed-l-v2.0',
  'nomic-ai/nomic-embed-text-v2-moe',
];

/** Ollama library 的候選：`<name>/<tag>`。 */
const OLLAMA_TAGS: readonly string[] = [
  'granite-embedding/278m',
  'paraphrase-multilingual/latest',
  'bge-m3/latest',
  'qwen3-embedding/0.6b',
  'snowflake-arctic-embed2/latest',
];

async function probeHf(repo: string): Promise<void> {
  const meta = await getJson(`https://huggingface.co/api/models/${repo}`);
  if (!meta.ok) {
    console.log(`HF ${repo} → ${meta.why}`);
    return;
  }
  const m = asRec(meta.body);
  const card = asRec(m['cardData']);
  const siblings = Array.isArray(m['siblings']) ? m['siblings'] : [];
  const files = siblings.map((s) => String(asRec(s)['rfilename'] ?? ''));
  const gguf = files.filter((f) => f.toLowerCase().endsWith('.gguf'));
  const onnx = files.filter((f) => f.toLowerCase().endsWith('.onnx'));
  console.log(
    JSON.stringify({
      repo,
      license: m['license'] ?? card['license'] ?? null,
      baseModel: card['base_model'] ?? null,
      lastModified: m['lastModified'] ?? null,
      downloads: m['downloads'] ?? null,
      likes: m['likes'] ?? null,
      gated: m['gated'] ?? null,
      ggufCount: gguf.length,
      gguf: gguf.slice(0, 6),
      onnxCount: onnx.length,
    }),
  );
}

/**
 * ollama.com 上一個模型有哪些 tag（與頁面上寫的大小）。
 *
 * **tag 名要實查，不憑印象**（`model-tasks-review.md` §6 的做法）：同一個家族每一代的 tag 寫法都不一樣
 * （`phi4` 與 `phi4-mini`、`mistral-small3.2`），猜錯的症狀是 `ollama pull` 404，猜對一個不存在的舊 tag 更糟。
 * 讀的是 HTML，所以只抓「`/library/<name>:<tag>`」這種連結與它後面最近的一個大小字串 —— 頁面改版就會抓不到，
 * **抓不到時照實說 0 個**，不回一份看起來完整的空清單。
 */
async function probeOllamaTags(name: string): Promise<void> {
  const url = `https://ollama.com/library/${name}/tags`;
  const { outcome } = await crawler.fetch(url);
  if (outcome.kind !== 'ok') {
    await appendFile(
      MANIFEST,
      `${JSON.stringify({ url, fetched_at: new Date().toISOString(), status: null, error: outcome.code })}\n`,
      'utf8',
    );
    console.log(`TAGS ${name} → ${outcome.code}`);
    return;
  }
  await appendFile(
    MANIFEST,
    `${JSON.stringify({
      url,
      fetched_at: new Date().toISOString(),
      status: outcome.status,
      content_type: outcome.contentType,
      sha256: sha256Of(outcome.bytes),
      bytes: outcome.bytes.byteLength,
    })}\n`,
    'utf8',
  );
  const html = new TextDecoder().decode(outcome.bytes);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const link = new RegExp(`/library/${escaped}:([A-Za-z0-9._-]+)`, 'g');
  const tags = new Map<string, string | null>();
  for (const match of html.matchAll(link)) {
    const tag = match[1];
    if (tag === undefined || tags.has(tag)) continue;
    const after = html.slice(match.index, match.index + 600);
    const size = /(\d+(?:\.\d+)?\s?[KMG]B)/.exec(after);
    tags.set(tag, size?.[1] ?? null);
  }
  console.log(JSON.stringify({ name, count: tags.size, tags: Object.fromEntries(tags) }));
}

async function probeOllama(tag: string): Promise<void> {
  const [name, version] = tag.split('/');
  const r = await getJson(`https://registry.ollama.ai/v2/library/${name}/manifests/${version}`);
  if (!r.ok) {
    console.log(`OLLAMA ${tag} → ${r.why}`);
    return;
  }
  const layers = Array.isArray(asRec(r.body)['layers'])
    ? (asRec(r.body)['layers'] as unknown[])
    : [];
  const total = layers.reduce<number>((sum, l) => sum + Number(asRec(l)['size'] ?? 0), 0);
  console.log(JSON.stringify({ tag, layers: layers.length, mib: Math.round(total / 1024 / 1024) }));
}

/**
 * HF 上有沒有人把某個模型轉成 GGUF。
 *
 * **轉檔的人不是模型作者** —— 查得到不代表可信，那是 B 級。
 * 這一支只回答「存不存在」，可不可信是另一個判斷。
 */
async function findGguf(term: string): Promise<void> {
  const url = `https://huggingface.co/api/models?search=${encodeURIComponent(term)}&filter=gguf&sort=downloads&direction=-1&limit=8`;
  const r = await getJson(url);
  if (!r.ok) {
    console.log(`FIND ${term} → ${r.why}`);
    return;
  }
  const rows = Array.isArray(r.body) ? r.body : [];
  console.log(
    JSON.stringify({
      term,
      hits: rows.map((x) => ({
        id: asRec(x)['id'],
        downloads: asRec(x)['downloads'],
        likes: asRec(x)['likes'],
      })),
    }),
  );
}

/**
 * 一個作者底下名字裡有某個字的 repo（`hf-search:<author>:<字>`）。
 *
 * 為了**找到正確的 repo 名**再去查授權與底座 —— 家族名跟 repo 名常常差一截
 * （Ollama 的 `granite4.2` 對 HF 的 `granite-4.2-…`），憑印象拼 repo 名會 404，或拿到同名的另一個模型。
 */
async function searchHf(author: string, term: string): Promise<void> {
  const url = `https://huggingface.co/api/models?author=${encodeURIComponent(author)}&search=${encodeURIComponent(term)}&sort=downloads&direction=-1&limit=20`;
  const r = await getJson(url);
  if (!r.ok) {
    console.log(`SEARCH ${author}:${term} → ${r.why}`);
    return;
  }
  const rows = Array.isArray(r.body) ? r.body : [];
  console.log(
    JSON.stringify({
      author,
      term,
      hits: rows.map((x) => asRec(x)['id']),
    }),
  );
}

const args = process.argv.slice(2);
if (args.length > 0) {
  for (const a of args) {
    if (a.startsWith('hf:')) await probeHf(a.slice(3));
    else if (a.startsWith('ollama-tags:')) await probeOllamaTags(a.slice(12));
    else if (a.startsWith('hf-search:')) {
      const [author = '', term = ''] = a.slice(10).split(':');
      await searchHf(author, term);
    } else if (a.startsWith('ollama:')) await probeOllama(a.slice(7));
    else if (a.startsWith('find:')) await findGguf(a.slice(5));
  }
} else {
  for (const repo of HF_REPOS) await probeHf(repo);
  for (const tag of OLLAMA_TAGS) await probeOllama(tag);
}
