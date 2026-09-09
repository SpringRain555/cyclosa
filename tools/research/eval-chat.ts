/**
 * `chat` 角色的評測：**同一組提示詞、同一份 schema、同一支正規化程式**，逐個模型跑。
 *
 * ## 這一支要回答的問題不是「哪個模型比較聰明」
 *
 * `capabilitiesOf` 對**每一個** Ollama 模型都宣告 `json_schema: true`，
 * 理由是 Ollama 的 `format` 參數做的是伺服器端的受限解碼 —— 那個宣告在**格式上**是對的。
 *
 * 但 `EXTRACT_SCHEMA` 那一段註解記著一件事：2026-09-08 第一次真的跑擴展時
 * **五個實體全部被標成 `person`**，而 schema 的 `enum` 完全沒有攔到 ——
 * **它保證了格式，沒有保證內容。**
 *
 * 所以這一支量的是那個宣告後面的東西：
 *
 * | 量什麼 | 為什麼它決定得了事情 |
 * |---|---|
 * | schema 有效率 | 硬需求。吐不出合法 JSON 的模型，這個任務直接不能用 |
 * | **引文命中率** | `locateQuote` 找不到的引文**那條邊就不存在**（ADR-0005）。命中率低 ＝ 抓了一堆網頁卻寫不進任何一條邊 |
 * | 角度之間的相似度 | 「多視角」如果全是同一個問題的改寫，這個功能就沒有價值 |
 * | `seeds` 指到真的東西 | 模型可以編一個不存在的編號。編了就代表「依據」那一欄是假的 |
 * | 延遲 | 本機模型沒有金額成本，時間就是全部的成本 |
 *
 * **引文命中率是這一份最重要的一欄。** 它直接量「模型有沒有捏造原文」，
 * 而且它是機器判的 —— 不需要任何人去讀輸出。
 *
 * ## 走的是真的會出貨的那幾支
 *
 * 提示詞用 `application/expansion-prompts.ts`、正規化用 `domain/provider/`、
 * 引文定位用 `locateQuote` —— 跟擴展作業實際跑的是同一條路。
 * 量測如果走另一條路，量到的就不是使用者會遇到的東西。
 *
 * 用法：
 *   npx tsx tools/research/eval-chat.ts <語料目錄> <輸出目錄> [模型 ...]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  locateQuote,
  normalizeAngles,
  normalizeExtraction,
} from '../../src/domain/provider/index.js';
import {
  ANGLES_SCHEMA,
  ANGLES_SYSTEM,
  anglesUser,
  EXTRACT_SCHEMA,
  EXTRACT_SYSTEM,
  extractUser,
  MAX_TEXT_CHARS,
  type SeedItem,
} from '../../src/application/expansion-prompts.js';

const rawHost = process.env['OLLAMA_HOST'] ?? '127.0.0.1:11434';
const OLLAMA = /^https?:\/\//.test(rawHost) ? rawHost : `http://${rawHost}`;

/** 每個任務重複幾次。**一次跑不出「穩不穩定」**，而穩定性正是這裡要問的。 */
const REPEATS = 3;

/** 角度之間的相似度用它算。**就是剛選定的那一個**（v0.10.1）。 */
const EMBED_MODEL = 'qwen3-embedding:4b';

const MODELS_DEFAULT = [
  'gemma4:31b',
  'olmo-3:32b-think',
  'nemotron-cascade-2:30b',
  'translategemma:12b',
];

interface Passage {
  readonly id: string;
  readonly lang: 'zh' | 'en';
  readonly page: string;
  readonly text: string;
}

interface ChatOutcome {
  readonly ok: boolean;
  readonly value: unknown;
  readonly ms: number;
  readonly why: string | null;
}

async function askJson(
  model: string,
  system: string,
  user: string,
  schema: unknown,
  timeoutMs = 300_000,
): Promise<ChatOutcome> {
  const t0 = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // **這就是 `json_schema: true` 那個宣告背後的東西。**
        format: schema,
        stream: false,
        options: { temperature: 0 },
      }),
      signal: controller.signal,
    });
    const ms = performance.now() - t0;
    if (!res.ok) return { ok: false, value: null, ms, why: `HTTP ${res.status}` };
    const body = (await res.json()) as { message?: { content?: string } };
    const content = body.message?.content ?? '';
    try {
      return { ok: true, value: JSON.parse(content), ms, why: null };
    } catch {
      // 受限解碼**應該**保證這裡解得開。解不開本身就是一個結果。
      return { ok: false, value: null, ms, why: `不是合法 JSON（${content.length} 字）` };
    }
  } catch (err) {
    return {
      ok: false,
      value: null,
      ms: performance.now() - t0,
      why: String(err).slice(0, 120),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function embed(input: readonly string[]): Promise<Float32Array[]> {
  const res = await fetch(`${OLLAMA}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
  });
  const body = (await res.json()) as { embeddings?: number[][] };
  return (body.embeddings ?? []).map((v) => {
    const out = new Float32Array(v.length);
    let sum = 0;
    for (const x of v) sum += x * x;
    const norm = Math.sqrt(sum) || 1;
    for (let i = 0; i < v.length; i++) out[i] = (v[i] as number) / norm;
    return out;
  });
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

// ── 任務一：多視角子問題 ────────────────────────────────────

interface AnglesRun {
  readonly schemaOk: boolean;
  readonly kept: number;
  readonly seedRefsValid: number;
  readonly seedRefsTotal: number;
  readonly maxPairSimilarity: number | null;
  readonly ms: number;
  readonly why: string | null;
  readonly sample: readonly string[];
}

async function runAngles(
  model: string,
  topic: string,
  seeds: readonly SeedItem[],
): Promise<AnglesRun> {
  const out = await askJson(model, ANGLES_SYSTEM, anglesUser(topic, seeds), ANGLES_SCHEMA);
  if (!out.ok) {
    return {
      schemaOk: false,
      kept: 0,
      seedRefsValid: 0,
      seedRefsTotal: 0,
      maxPairSimilarity: null,
      ms: out.ms,
      why: out.why,
      sample: [],
    };
  }

  const rawAngles = (out.value as { angles?: unknown } | null)?.angles;
  // **同一支正規化程式** —— 它會丟掉重複與指到不存在的 seed。
  const kept = normalizeAngles(rawAngles, seeds.length);

  // `seeds` 是 1-based 的編號。**模型可以編一個不存在的** ——
  // 編了的話畫面上那一欄「依據」就是假的。
  const rawList = Array.isArray(rawAngles) ? rawAngles : [];
  let refsTotal = 0;
  let refsValid = 0;
  for (const entry of rawList) {
    const list = (entry as { seeds?: unknown } | null)?.seeds;
    for (const n of Array.isArray(list) ? list : []) {
      refsTotal++;
      if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= seeds.length) refsValid++;
    }
  }

  // **角度之間有多像。** 全是同一個問題的改寫的話，「多視角」就沒有價值。
  let maxPair: number | null = null;
  const questions = kept.map((a) => a.question);
  if (questions.length >= 2) {
    const vecs = await embed(questions);
    let worst = -1;
    for (let i = 0; i < vecs.length; i++) {
      for (let j = i + 1; j < vecs.length; j++) {
        worst = Math.max(worst, cosine(vecs[i] as Float32Array, vecs[j] as Float32Array));
      }
    }
    maxPair = worst;
  }

  return {
    schemaOk: true,
    kept: kept.length,
    seedRefsValid: refsValid,
    seedRefsTotal: refsTotal,
    maxPairSimilarity: maxPair,
    ms: out.ms,
    why: null,
    sample: questions.slice(0, 3),
  };
}

// ── 任務二：從正文抽實體與關係 ──────────────────────────────

interface ExtractRun {
  readonly schemaOk: boolean;
  readonly entities: number;
  readonly relations: number;
  readonly quotesFound: number;
  readonly typeSpread: number;
  readonly ms: number;
  readonly why: string | null;
  readonly sampleMiss: string | null;
}

async function runExtract(model: string, title: string, text: string): Promise<ExtractRun> {
  const body = text.slice(0, MAX_TEXT_CHARS);
  const out = await askJson(model, EXTRACT_SYSTEM, extractUser(title, body), EXTRACT_SCHEMA);
  if (!out.ok) {
    return {
      schemaOk: false,
      entities: 0,
      relations: 0,
      quotesFound: 0,
      typeSpread: 0,
      ms: out.ms,
      why: out.why,
      sampleMiss: null,
    };
  }

  const extraction = normalizeExtraction(out.value);

  // **引文命中率。** `locateQuote` 找不到的話那條邊就不存在（ADR-0005），
  // 所以這個數字就是「這次呼叫有多少比例真的變成了圖上的東西」。
  let found = 0;
  let sampleMiss: string | null = null;
  for (const rel of extraction.relations) {
    if (locateQuote(body, rel.quote).kind === 'found') found++;
    else if (sampleMiss === null) sampleMiss = rel.quote.slice(0, 80);
  }

  // 六個型別用到幾個。**全部標成同一個型別**是 2026-09-08 真的發生過的事。
  const typeSpread = new Set(extraction.entities.map((e) => e.type)).size;

  return {
    schemaOk: true,
    entities: extraction.entities.length,
    relations: extraction.relations.length,
    quotesFound: found,
    typeSpread,
    ms: out.ms,
    why: null,
    sampleMiss,
  };
}

// ── 主流程 ──────────────────────────────────────────────────

const [corpusDir, outDir, ...only] = process.argv.slice(2);
if (corpusDir === undefined || outDir === undefined) {
  console.error('用法：npx tsx tools/research/eval-chat.ts <語料目錄> <輸出目錄> [模型 ...]');
  process.exit(2);
}
await mkdir(outDir, { recursive: true });

const passages: Passage[] = (await readFile(join(corpusDir, 'corpus.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Passage);

/**
 * 抽取用的文件：**一份中文、一份英文**，都是真的抓回來的頁面。
 * 中文那一份特別重要 —— 這個工具的介面是繁中，而 tokenizer 對中文的差異最大。
 */
function documentOf(lang: 'zh' | 'en'): { title: string; text: string } {
  const byPage = new Map<string, string[]>();
  for (const p of passages.filter((x) => x.lang === lang)) {
    const list = byPage.get(p.page) ?? [];
    list.push(p.text);
    byPage.set(p.page, list);
  }
  // 取字數最接近上限的那一篇 —— **要讓 context 這一欄真的被用到**。
  let best = { title: '', text: '' };
  for (const [page, parts] of byPage) {
    const joined = parts.join('\n');
    if (Math.abs(joined.length - MAX_TEXT_CHARS) < Math.abs(best.text.length - MAX_TEXT_CHARS)) {
      best = { title: page, text: joined };
    }
  }
  return best;
}

const docs = { zh: documentOf('zh'), en: documentOf('en') };
/** 角度那一步的素材：拿真實頁面的標題當既有內容。 */
const seeds: SeedItem[] = passages
  .filter((p) => p.lang === 'zh')
  .map((p) => ({ title: p.page, excerpt: p.text.slice(0, 120) }))
  .filter((s, i, arr) => arr.findIndex((x) => x.title === s.title) === i)
  .slice(0, 8);
const TOPIC = '蜘蛛結網行為與它的演化';

console.error(
  `語料 ${passages.length} 段｜角度素材 ${seeds.length} 份｜` +
    `抽取文件 中文 ${docs.zh.text.length} 字（${docs.zh.title}）、英文 ${docs.en.text.length} 字（${docs.en.title}）`,
);

const models = only.length > 0 ? only : MODELS_DEFAULT;
const results: Record<string, unknown>[] = [];

for (const model of models) {
  console.error(`\n── ${model}`);
  const angles: AnglesRun[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const r = await runAngles(model, TOPIC, seeds);
    angles.push(r);
    console.error(
      `  角度 ${i + 1}/${REPEATS}: ${r.schemaOk ? `${r.kept} 條、最大相似度 ${r.maxPairSimilarity?.toFixed(3) ?? '—'}` : `失敗（${r.why ?? ''}）`} ${(r.ms / 1000).toFixed(1)}s`,
    );
  }

  const extracts: (ExtractRun & { lang: string })[] = [];
  for (const lang of ['zh', 'en'] as const) {
    for (let i = 0; i < REPEATS; i++) {
      const r = await runExtract(model, docs[lang].title, docs[lang].text);
      extracts.push({ ...r, lang });
      console.error(
        `  抽取 ${lang} ${i + 1}/${REPEATS}: ${
          r.schemaOk
            ? `實體 ${r.entities}（${r.typeSpread} 型）、關係 ${r.relations}、引文命中 ${r.quotesFound}/${r.relations}`
            : `失敗（${r.why ?? ''}）`
        } ${(r.ms / 1000).toFixed(1)}s`,
      );
    }
  }

  const okAngles = angles.filter((a) => a.schemaOk);
  const okExtracts = extracts.filter((e) => e.schemaOk);
  const totalRels = okExtracts.reduce((s, e) => s + e.relations, 0);
  const totalFound = okExtracts.reduce((s, e) => s + e.quotesFound, 0);

  results.push({
    model,
    angles: {
      schemaOkRate: angles.filter((a) => a.schemaOk).length / angles.length,
      keptMean: mean(okAngles.map((a) => a.kept)),
      seedRefValidRate:
        okAngles.reduce((s, a) => s + a.seedRefsTotal, 0) === 0
          ? null
          : okAngles.reduce((s, a) => s + a.seedRefsValid, 0) /
            okAngles.reduce((s, a) => s + a.seedRefsTotal, 0),
      maxPairSimilarityMean: mean(
        okAngles.map((a) => a.maxPairSimilarity).filter((v): v is number => v !== null),
      ),
      msMean: mean(angles.map((a) => a.ms)),
      samples: okAngles[0]?.sample ?? [],
    },
    extract: {
      schemaOkRate: okExtracts.length / extracts.length,
      entitiesMean: mean(okExtracts.map((e) => e.entities)),
      relationsMean: mean(okExtracts.map((e) => e.relations)),
      // **這一欄是重點。** 引文找不到 ＝ 那條邊不存在。
      quoteHitRate: totalRels === 0 ? null : totalFound / totalRels,
      typeSpreadMean: mean(okExtracts.map((e) => e.typeSpread)),
      msMean: mean(extracts.map((e) => e.ms)),
      failures: extracts.filter((e) => !e.schemaOk).map((e) => `${e.lang}: ${e.why ?? ''}`),
      sampleMiss: okExtracts.find((e) => e.sampleMiss !== null)?.sampleMiss ?? null,
    },
    raw: { angles, extracts },
  });
}

await writeFile(join(outDir, 'chat-results.json'), JSON.stringify(results, null, 2) + '\n', 'utf8');
console.error(`\n寫到 ${join(outDir, 'chat-results.json')}`);
