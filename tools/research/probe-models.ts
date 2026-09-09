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
 *
 * 每一次請求都會**接一列進 `docs/research/sources/manifest.jsonl`**。
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
  'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2',
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

const args = process.argv.slice(2);
if (args.length > 0) {
  for (const a of args) {
    if (a.startsWith('hf:')) await probeHf(a.slice(3));
    else if (a.startsWith('ollama:')) await probeOllama(a.slice(7));
    else if (a.startsWith('find:')) await findGguf(a.slice(5));
  }
} else {
  for (const repo of HF_REPOS) await probeHf(repo);
  for (const tag of OLLAMA_TAGS) await probeOllama(tag);
}
