/**
 * 嵌入模型評測：**同一批文字、同一組查詢、同一支比對程式**，逐個模型跑一次。
 *
 * ## 三件事決定這份量測算不算數
 *
 * 1. **查詢集在跑任何模型之前就寫死並提交**（`docs/research/embedding-eval-queries.jsonl`）。
 *    先看結果再調查詢，量到的是「我想要誰贏」。
 * 2. **每個模型用它自己 model card 上寫的前綴**。少加前綴等於把那個模型的分數量低，
 *    而那是量測的問題不是模型的問題 —— 出處記在下面 `MODELS` 的每一列。
 * 3. **全文檢索也跑同一組查詢**，而且走的是 `domain/search/` 裡**真的會出貨的那幾支**
 *    （`parseQuery` → bigram AND → `checkText` 正文確認 → `rankHits`）。
 *    沒有這一欄，「語意檢索有沒有補上全文檢索補不了的那一塊」就沒有比較基準。
 *
 * ## 指標
 *
 * - **recall@10** —— 前 10 筆裡有沒有正確答案。答「找不找得到」。
 * - **MRR@10** —— 正確答案排第幾的倒數。答「要不要往下捲」。
 *
 * 兩個都報。只報 recall 會讓一個把答案排第 9 的模型看起來跟排第 1 的一樣好。
 *
 * 用法：
 *   npx tsx tools/research/eval-embeddings.ts <語料目錄> <查詢檔> <輸出目錄> [模型 ...]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { parseQuery, checkText, rankHits } from '../../src/domain/search/query.js';
import { bigrams } from '../../src/domain/search/tokenize.js';

/**
 * Ollama 的位址。
 *
 * **`OLLAMA_HOST` 的慣例是不帶 scheme**（本機實測值就是 `127.0.0.1:11434`），
 * 而 `fetch` 對沒有 scheme 的字串會丟 `Failed to parse URL` ——
 * 第一次跑七個模型全部倒在這一行。補上去而不是要求環境改。
 */
const rawHost = process.env['OLLAMA_HOST'] ?? '127.0.0.1:11434';
const OLLAMA = /^https?:\/\//.test(rawHost) ? rawHost : `http://${rawHost}`;
const TOP_K = 10;
const BATCH = 16;

interface Passage {
  readonly id: string;
  readonly lang: 'zh' | 'en';
  readonly group: string;
  readonly page: string;
  readonly text: string;
}

interface Query {
  readonly id: string;
  readonly kind: 'cross' | 'para' | 'lex';
  readonly q: string;
  readonly targets: readonly string[];
}

/**
 * 前綴照各模型自己的 model card。
 *
 * `qwen3-embedding` 的指令字串直接抄 card 上那一行（`Query:` 後面沒有空白，
 * 那是它自己寫的）。**照抄比「看起來比較整齊」重要** —— 這一段是模型訓練時看到的形狀。
 */
interface ModelSpec {
  readonly name: string;
  readonly queryPrefix: string;
  readonly docPrefix: string;
  /** 前綴的出處，寫進結果檔。 */
  readonly prefixSource: string;
}

const TASK = 'Given a web search query, retrieve relevant passages that answer the query';

const MODELS: readonly ModelSpec[] = [
  { name: 'bge-m3', queryPrefix: '', docPrefix: '', prefixSource: 'BAAI/bge-m3 README：沒有前綴' },
  {
    name: 'qwen3-embedding:0.6b',
    queryPrefix: `Instruct: ${TASK}\nQuery:`,
    docPrefix: '',
    prefixSource: 'Qwen/Qwen3-Embedding-0.6B README get_detailed_instruct()',
  },
  {
    name: 'qwen3-embedding:4b',
    queryPrefix: `Instruct: ${TASK}\nQuery:`,
    docPrefix: '',
    prefixSource: '同 0.6B（同一個系列）',
  },
  {
    name: 'snowflake-arctic-embed2',
    queryPrefix: 'query: ',
    docPrefix: '',
    prefixSource: 'Snowflake/snowflake-arctic-embed-l-v2.0 README：query_prefix，只加在查詢上',
  },
  {
    name: 'granite-embedding:278m',
    queryPrefix: '',
    docPrefix: '',
    prefixSource: 'ibm-granite/granite-embedding-278m-multilingual README：沒有前綴',
  },
  {
    name: 'paraphrase-multilingual',
    queryPrefix: '',
    docPrefix: '',
    prefixSource: 'sentence-transformers/paraphrase-multilingual-mpnet-base-v2 README：沒有前綴',
  },
  {
    name: 'hf.co/nomic-ai/nomic-embed-text-v2-moe-GGUF:F16',
    queryPrefix: 'search_query: ',
    docPrefix: 'search_document: ',
    prefixSource:
      'nomic-ai/nomic-embed-text-v2-moe README：「The text prompt *must* include a task instruction prefix」',
  },
  // 對照組：同一個模型**不加前綴**。前綴到底值多少分，這一列回答。
  {
    name: 'hf.co/nomic-ai/nomic-embed-text-v2-moe-GGUF:F16',
    queryPrefix: '',
    docPrefix: '',
    prefixSource: '（對照組：刻意不加前綴）',
  },
];

async function embed(model: string, input: readonly string[]): Promise<Float32Array[]> {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input }),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { embeddings?: number[][] };
  const rows = body.embeddings ?? [];
  if (rows.length !== input.length) {
    throw new Error(`${model}: 回了 ${rows.length} 個向量，送出去 ${input.length} 個`);
  }
  return rows.map(normalize);
}

/** 單位化 —— 之後的內積就是餘弦。 */
function normalize(v: readonly number[]): Float32Array {
  const out = new Float32Array(v.length);
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / norm;
  return out;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

function median(xs: readonly number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1
    ? (s[mid] as number)
    : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

// ── 全文檢索基準線：走真的會出貨的那幾支 ─────────────────────

/**
 * 用 `domain/search/` 的規則把段落排出來。
 *
 * 這是 `application/search-service.ts` 的流程搬到記憶體裡：
 * bigram 全部命中（AND）→ 拿候選 → **回正文確認** → `rankHits`。
 */
function lexicalRank(
  passages: readonly Passage[],
  grams: Map<string, Map<string, number>>,
  q: string,
): string[] {
  const parsed = parseQuery(q);
  if (parsed === null) return [];

  const counts = new Map<string, number>();
  const seen = new Map<string, number>();
  for (const gram of parsed.grams) {
    const owners = grams.get(gram);
    if (owners === undefined) continue;
    for (const [id, freq] of owners) {
      counts.set(id, (counts.get(id) ?? 0) + freq);
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
  }
  const byId = new Map(passages.map((p) => [p.id, p]));
  const candidates: string[] = [];
  for (const [id, hits] of seen) {
    if (hits === parsed.grams.length) candidates.push(id);
  }
  // 拉丁片語那一條：FTS5 這裡用子字串近似（同樣是 AND 語意）。
  if (parsed.phrase !== null) {
    const needle = parsed.phrase.replace(/^"|"$/g, '').replace(/""/g, '"');
    for (const p of passages) {
      if (!candidates.includes(p.id) && p.text.toLowerCase().includes(needle))
        candidates.push(p.id);
    }
  }

  const ranked = rankHits(
    candidates.map((id) => {
      const p = byId.get(id) as Passage;
      const checked = checkText(p.text, parsed.raw);
      return {
        id,
        status: checked.status,
        inTitle: false,
        indexScore: counts.get(id) ?? 0,
        titleRank: p.page,
      };
    }),
  );
  return ranked.map((r) => r.id);
}

// ── 指標 ────────────────────────────────────────────────────

interface Scored {
  readonly queryId: string;
  readonly kind: Query['kind'];
  readonly rank: number | null;
  readonly top: readonly string[];
}

function scoreOne(ranked: readonly string[], targets: readonly string[]): number | null {
  const set = new Set(targets);
  for (let i = 0; i < Math.min(ranked.length, TOP_K); i++) {
    if (set.has(ranked[i] as string)) return i + 1;
  }
  return null;
}

function summarize(
  rows: readonly Scored[],
): Record<string, { n: number; recall: number; mrr: number }> {
  const groups: Record<string, Scored[]> = { all: [...rows] };
  for (const r of rows) (groups[r.kind] = groups[r.kind] ?? []).push(r);
  const out: Record<string, { n: number; recall: number; mrr: number }> = {};
  for (const [k, list] of Object.entries(groups)) {
    const hits = list.filter((r) => r.rank !== null);
    out[k] = {
      n: list.length,
      recall: hits.length / list.length,
      mrr: list.reduce((s, r) => s + (r.rank === null ? 0 : 1 / r.rank), 0) / list.length,
    };
  }
  return out;
}

// ── 主流程 ──────────────────────────────────────────────────

const [corpusDir, queriesFile, outDir, ...only] = process.argv.slice(2);
if (corpusDir === undefined || queriesFile === undefined || outDir === undefined) {
  console.error(
    '用法：npx tsx tools/research/eval-embeddings.ts <語料目錄> <查詢檔> <輸出目錄> [模型 ...]',
  );
  process.exit(2);
}
await mkdir(outDir, { recursive: true });

const passages: Passage[] = (await readFile(join(corpusDir, 'corpus.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Passage);

const queries: Query[] = (await readFile(queriesFile, 'utf8'))
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Record<string, unknown>)
  .filter((r) => typeof r['id'] === 'string')
  .map((r) => r as unknown as Query);

// 目標段落要真的在語料裡。**打錯一個 id 會讓那一條永遠 0 分**，
// 而那看起來會像是所有模型都答不出來。
const ids = new Set(passages.map((p) => p.id));
const bad = queries.flatMap((q) =>
  q.targets.filter((t) => !ids.has(t)).map((t) => `${q.id} → ${t}`),
);
if (bad.length > 0) {
  console.error(`查詢集指到不存在的段落：\n  ${bad.join('\n  ')}`);
  process.exit(1);
}
console.error(`語料 ${passages.length} 段、查詢 ${queries.length} 條`);

const results: Record<string, unknown>[] = [];
const pool: Record<string, Record<string, string[]>> = {};

// —— 基準線：全文檢索 ——
{
  const t0 = performance.now();
  const index = new Map<string, Map<string, number>>();
  for (const p of passages) {
    for (const [gram, freq] of bigrams(p.text)) {
      let owners = index.get(gram);
      if (owners === undefined) {
        owners = new Map();
        index.set(gram, owners);
      }
      owners.set(p.id, freq);
    }
  }
  const buildMs = performance.now() - t0;

  const times: number[] = [];
  const rows: Scored[] = [];
  for (const q of queries) {
    const t1 = performance.now();
    const ranked = lexicalRank(passages, index, q.q);
    times.push(performance.now() - t1);
    rows.push({
      queryId: q.id,
      kind: q.kind,
      rank: scoreOne(ranked, q.targets),
      top: ranked.slice(0, 5),
    });
    (pool[q.id] = pool[q.id] ?? {})['全文檢索'] = ranked.slice(0, 5);
  }
  results.push({
    model: '（基準線）全文檢索 bigram+驗證',
    dim: null,
    buildMs: Math.round(buildMs),
    queryMsMedian: Number(median(times).toFixed(2)),
    prefixSource: 'domain/search/ 的 parseQuery → checkText → rankHits',
    metrics: summarize(rows),
    rows,
  });
  const b = summarize(rows)['all'] as { recall: number; mrr: number };
  console.error(
    `基準線 全文檢索: recall@10=${(b.recall * 100).toFixed(1)}% MRR@10=${b.mrr.toFixed(3)} 建索引 ${Math.round(buildMs)} ms、查詢中位數 ${median(times).toFixed(2)} ms`,
  );
}

// —— 各模型 ——
for (const spec of MODELS) {
  const label =
    spec.queryPrefix === '' && spec.docPrefix === '' && spec.name.includes('nomic')
      ? `${spec.name}（無前綴對照）`
      : spec.name;
  if (only.length > 0 && !only.includes(spec.name)) continue;

  try {
    const t0 = performance.now();
    const vectors: Float32Array[] = [];
    for (let i = 0; i < passages.length; i += BATCH) {
      const slice = passages.slice(i, i + BATCH).map((p) => spec.docPrefix + p.text);
      vectors.push(...(await embed(spec.name, slice)));
      if (i % (BATCH * 20) === 0) process.stderr.write(`\r  ${label}: ${i}/${passages.length}   `);
    }
    const buildMs = performance.now() - t0;
    const dim = vectors[0]?.length ?? 0;

    const times: number[] = [];
    const rows: Scored[] = [];
    for (const q of queries) {
      const t1 = performance.now();
      const [qv] = await embed(spec.name, [spec.queryPrefix + q.q]);
      const embedMs = performance.now() - t1;
      const scored = passages.map((p, i) => ({
        id: p.id,
        s: dot(qv as Float32Array, vectors[i] as Float32Array),
      }));
      scored.sort((a, b) => b.s - a.s);
      times.push(embedMs);
      const ranked = scored.map((x) => x.id);
      rows.push({
        queryId: q.id,
        kind: q.kind,
        rank: scoreOne(ranked, q.targets),
        top: ranked.slice(0, 5),
      });
      (pool[q.id] = pool[q.id] ?? {})[label] = ranked.slice(0, 5);
    }

    const m = summarize(rows);
    results.push({
      model: label,
      dim,
      buildMs: Math.round(buildMs),
      passagesPerSec: Number((passages.length / (buildMs / 1000)).toFixed(1)),
      queryEmbedMsMedian: Number(median(times).toFixed(1)),
      prefixSource: spec.prefixSource,
      metrics: m,
      rows,
    });
    const all = m['all'] as { recall: number; mrr: number };
    console.error(
      `\r  ${label}: dim=${dim} recall@10=${(all.recall * 100).toFixed(1)}% MRR@10=${all.mrr.toFixed(3)} 建索引 ${(buildMs / 1000).toFixed(1)}s`,
    );
  } catch (err) {
    console.error(`\r  ${label}: 失敗 —— ${String(err).slice(0, 200)}`);
    results.push({ model: label, error: String(err).slice(0, 400) });
  }
}

await writeFile(join(outDir, 'results.json'), JSON.stringify(results, null, 2) + '\n', 'utf8');
await writeFile(join(outDir, 'pool.json'), JSON.stringify(pool, null, 2) + '\n', 'utf8');
console.error(`\n寫到 ${join(outDir, 'results.json')}`);
