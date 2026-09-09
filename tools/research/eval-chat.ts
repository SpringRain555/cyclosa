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
  REQUIRED_CONTEXT_TOKENS,
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
  /**
   * 進去與出來各幾個 token（`prompt_eval_count` / `eval_count`）。
   *
   * **這兩個數字是 `num_ctx` 那條決定的唯一證據。**
   * 出貨的請求送 `num_ctx: REQUIRED_CONTEXT_TOKENS`，而那個常數的來歷是
   * 「正文 14,400 ＋ 提示 600 ＋ **輸出約 2,000**」——
   * 最後那一項是估的，從來沒有量過。輸入＋輸出真的超過視窗的話，
   * 受限解碼會在中途沒有空間可用，**而回來的是一份空字串，不是錯誤**。
   *
   * 問不到就是 `null`（模型沒回這兩欄）。**不要填 0** —— 那會讓
   * 「沒有輸出」跟「不知道有多少輸出」在表上長得一樣。
   */
  readonly promptTokens: number | null;
  readonly evalTokens: number | null;
}

async function askJson(
  model: string,
  system: string,
  user: string,
  schema: unknown,
  /**
   * `false` 時明確關掉 thinking。`null` ＝ 不帶這一欄，
   * 也就是**出貨那一支目前的行為**（吃模型自己的預設）。
   *
   * 原本這裡只送給宣告了 `thinking` 的模型，理由寫著「對其他模型送
   * Ollama 會回 400」。**那是猜的，而且是錯的** —— 2026-09-09 實測，
   * `granite4.2:8b`（`/api/tags` 的 capabilities 只有 `completion`）
   * 收下 `think: false` 沒有報錯。
   *
   * 這件事不只是「少一個限制」：granite 的抽取每次要吐一萬到兩萬四千個
   * token 才生出十幾個實體，而**那些 token 是不是思考，本來因為這個
   * 假設而測不到**。一個沒查證的假設把一整條路擋掉了。
   */
  think: boolean | null = null,
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
        ...(think === null ? {} : { think }),
        /**
         * **要跟出貨的那一支一模一樣。**
         *
         * 這一欄 2026-09-09 之前不在這裡，而那讓量測與出貨跑在不同的設定上：
         * `OLLAMA_CONTEXT_LENGTH` 沒設時 Ollama 載入的是 **32768**（實測），
         * 而 `chat-ollama.ts` 明確送 18000。兩者的 KV 快取差 1.8 倍，
         * **而延遲正是這一份要量的東西** —— 用比較寬鬆的設定量出來的秒數，
         * 不是使用者會遇到的秒數。
         */
        options: { temperature: 0, num_ctx: REQUIRED_CONTEXT_TOKENS },
      }),
      signal: controller.signal,
    });
    const ms = performance.now() - t0;
    const none = { promptTokens: null, evalTokens: null };
    if (!res.ok) return { ok: false, value: null, ms, why: `HTTP ${res.status}`, ...none };
    const body = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: unknown;
      eval_count?: unknown;
    };
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const counts = {
      promptTokens: num(body.prompt_eval_count),
      evalTokens: num(body.eval_count),
    };
    const content = body.message?.content ?? '';
    try {
      return { ok: true, value: JSON.parse(content), ms, why: null, ...counts };
    } catch {
      // 受限解碼**應該**保證這裡解得開。解不開本身就是一個結果。
      return {
        ok: false,
        value: null,
        ms,
        why: `不是合法 JSON（${content.length} 字）`,
        ...counts,
      };
    }
  } catch (err) {
    return {
      ok: false,
      value: null,
      ms: performance.now() - t0,
      why: String(err).slice(0, 120),
      promptTokens: null,
      evalTokens: null,
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
  /**
   * **每條角度離「這個專題的主題」有多遠。**
   *
   * 2026-09-09 補的，因為 `maxPairSimilarity` 這一欄**獎勵了錯的東西**。
   * 它量的是角度彼此有多發散，而**胡說八道是很發散的**：
   * `olmo-3:32b-think` 的發散度最好（0.681），而它問的是
   * 「蜘蛛結網行為的演化如何與其**光合作用能力**的發展相關」；
   * `translategemma:12b` 發散度最差（0.800），三條全部切題。
   *
   * 失效的機制看得出來：素材（`seeds`）是語料裡**別的頁面的標題**
   * （区块链、光合作用、Knowledge graph…），而有些模型會把素材的主題
   * 當成這個專題的角度 —— 於是角度之間確實不像，但它們也不是這個專題的。
   *
   * 所以要兩欄一起看：**彼此夠不同（低 `maxPair`）而且都還在題目上（高這一欄）**。
   */
  readonly topicSimilarity: number | null;
  /**
   * **幾條角度飄到別的素材上去了。**
   *
   * `topicSimilarity` 補上之後量出來的東西**跟樣本對不上**：
   * `qwen3.5:4b` 離主題最近（0.719），而它問的是「免疫系統中的病原體壓力」；
   * `nemotron-cascade-2:30b` 離主題最遠（0.593），三條卻全部切題 ——
   * 它的問句都以「接下來該查什麼…」開頭，**長句把相似度稀釋掉了**。
   * 那一欄量到的是句子長度，不是離題。
   *
   * 這一欄改成**相對的**：同一條角度，對主題的相似度減掉
   * 對最像的那份素材標題的相似度。**兩邊用同一個向量，長度效應自己抵消。**
   * 差是負的 ＝ 這條角度更像某份素材而不是這個專題 ＝ 飄走了。
   *
   * 素材本來就該被用到（角度是從既有內容長出來的），
   * 所以「像素材」本身不是問題；**「比像主題還像素材」才是**。
   */
  readonly driftedAngles: number | null;
  readonly ms: number;
  readonly why: string | null;
  readonly sample: readonly string[];
}

async function runAngles(
  model: string,
  topic: string,
  seeds: readonly SeedItem[],
  think: boolean | null,
): Promise<AnglesRun> {
  const out = await askJson(model, ANGLES_SYSTEM, anglesUser(topic, seeds), ANGLES_SCHEMA, think);
  if (!out.ok) {
    return {
      schemaOk: false,
      kept: 0,
      seedRefsValid: 0,
      seedRefsTotal: 0,
      maxPairSimilarity: null,
      topicSimilarity: null,
      driftedAngles: null,
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
  // **而只有這一欄會選出胡說八道的模型** —— 所以同時量離題目有多遠。
  let maxPair: number | null = null;
  let topicSim: number | null = null;
  const questions = kept.map((a) => a.question);
  let drifted: number | null = null;
  if (questions.length >= 1) {
    const seedTitles = seeds.map((x) => x.title);
    const vecs = await embed([topic, ...seedTitles, ...questions]);
    const topicVec = vecs[0] as Float32Array;
    const seedVecs = vecs.slice(1, 1 + seedTitles.length);
    const angleVecs = vecs.slice(1 + seedTitles.length);
    topicSim =
      angleVecs.reduce((acc, v) => acc + cosine(topicVec, v), 0) / Math.max(1, angleVecs.length);
    drifted = angleVecs.filter((v) => {
      const toTopic = cosine(topicVec, v);
      const toSeed = seedVecs.reduce((m, sv) => Math.max(m, cosine(sv, v)), -1);
      return toSeed > toTopic;
    }).length;
    if (angleVecs.length >= 2) {
      let worst = -1;
      for (let i = 0; i < angleVecs.length; i++) {
        for (let j = i + 1; j < angleVecs.length; j++) {
          worst = Math.max(
            worst,
            cosine(angleVecs[i] as Float32Array, angleVecs[j] as Float32Array),
          );
        }
      }
      maxPair = worst;
    }
  }

  return {
    schemaOk: true,
    kept: kept.length,
    seedRefsValid: refsValid,
    seedRefsTotal: refsTotal,
    maxPairSimilarity: maxPair,
    topicSimilarity: topicSim,
    driftedAngles: drifted,
    ms: out.ms,
    why: null,
    sample: questions.slice(0, 3),
  };
}

// ── 任務二：從正文抽實體與關係 ──────────────────────────────

interface ExtractRun {
  /**
   * **模型回的引文原文，一條不漏。**
   *
   * 存它的理由是成本：`locateQuote` 的比對規則一改，
   * 「引文命中率」那一欄就要重算，而重算原本要重跑一輪抽取
   * —— 八個模型、六次、將近一小時的 GPU。**存下來之後重新記分是免費的。**
   *
   * 而那個規則確實還會改：2026-09-09 追進兩條「找不到」的引文，
   * 兩條都不是捏造 —— 一條把半形句點寫成全形，一條逐字照抄但多收了一個引號。
   * 「模型編的」與「模型少打一個標點」在這一欄裡長得一模一樣，
   * 而**要判斷該不該放寬比對，得先看得到那些字**。
   */
  readonly quotes: readonly string[];
  /** 這一次送進去的正文。重新比對要拿它當乾草堆。 */
  readonly body: string;
  readonly promptTokens: number | null;
  readonly evalTokens: number | null;
  readonly schemaOk: boolean;
  readonly entities: number;
  readonly relations: number;
  readonly quotesFound: number;
  readonly typeSpread: number;
  readonly ms: number;
  readonly why: string | null;
  readonly sampleMiss: string | null;
}

async function runExtract(
  model: string,
  title: string,
  text: string,
  think: boolean | null,
): Promise<ExtractRun> {
  const body = text.slice(0, MAX_TEXT_CHARS);
  const out = await askJson(model, EXTRACT_SYSTEM, extractUser(title, body), EXTRACT_SCHEMA, think);
  if (!out.ok) {
    return {
      quotes: [],
      body,
      promptTokens: out.promptTokens,
      evalTokens: out.evalTokens,
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
    quotes: extraction.relations.map((r) => r.quote),
    body,
    promptTokens: out.promptTokens,
    evalTokens: out.evalTokens,
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

const argv = process.argv.slice(2);
/**
 * `--no-think` ＝ 對**宣告了 `thinking` 的模型**明確送 `think: false`。
 *
 * 出貨的 `chat-ollama.ts` 目前不帶這一欄，也就是**吃模型自己的預設**，
 * 而新一代的模型多半預設是開的。第一輪 `olmo-3:32b-think` 的六次抽取
 * 全部超過出貨的 180 秒（278–300 秒），那些時間幾乎都花在思考上。
 *
 * 所以這一欄要量不要猜：**同一個模型、同一份語料，開與關各跑一遍。**
 *
 * ## 量完之後，`--no-think` 才是出貨的那條路
 *
 * 2026-09-09 量完，`chat-ollama.ts` 已經改成明確送 `think: false`
 * （`granite4.2:8b` 22,545 → 3,256 個輸出 token、157 → 27.7 秒）。
 * **所以要重現出貨的行為，這個旗標要打開。**
 *
 * 不把它改成預設，是因為那個對照本身還要能跑：
 * 少了「不送這一欄」的那一半，「關掉比較好」就變成一句不能被反駁的話。
 */
const noThink = argv.includes('--no-think');
/** `--angles-only` ＝ 只跑角度。補一欄指標時不必把抽取那一輪重跑一次。 */
const anglesOnly = argv.includes('--angles-only');
const [corpusDir, outDir, ...only] = argv.filter(
  (a) => a !== '--no-think' && a !== '--angles-only',
);
if (corpusDir === undefined || outDir === undefined) {
  console.error(
    '用法：npx tsx tools/research/eval-chat.ts <語料目錄> <輸出目錄> [--no-think] [模型 ...]',
  );
  process.exit(2);
}
await mkdir(outDir, { recursive: true });

const passages: Passage[] = (await readFile(join(corpusDir, 'corpus.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Passage);

/**
 * 抽取用的文件：**每一次重複換一篇，不是同一篇跑三次。**
 *
 * 2026-09-09 修正。原本三次送同一份正文，而那讓第二、三次
 * **大部分的提示詞都命中 KV 快取** —— 秒數會漂亮，但那不是使用者的情況：
 * 真的在用的時候每一份文件都是新的。
 *
 * 同一份重跑三次的實測後果：`prompt_eval_count` 從 13,296 掉到 6,702，
 * 而輸出在溫度 0 之下也跟著變（2,400 → 11,474 → 1,595 個 token）。
 * **那三次不是三個獨立樣本，是一次量測加兩次回音。**
 *
 * 現在取字數最接近上限的前 n 篇：系統提示照樣命中快取（那本來就會發生），
 * 正文不會 —— 這才是實際的形狀。中文那幾篇特別重要，
 * 這個工具的介面是繁中，而 tokenizer 對中文的差異最大。
 */
function documentsOf(lang: 'zh' | 'en', n: number): { title: string; text: string }[] {
  const byPage = new Map<string, string[]>();
  for (const p of passages.filter((x) => x.lang === lang)) {
    const list = byPage.get(p.page) ?? [];
    list.push(p.text);
    byPage.set(p.page, list);
  }
  return [...byPage.entries()]
    .map(([title, parts]) => ({ title, text: parts.join('\n') }))
    .sort(
      (a, b) => Math.abs(a.text.length - MAX_TEXT_CHARS) - Math.abs(b.text.length - MAX_TEXT_CHARS),
    )
    .slice(0, n);
}

const docs = { zh: documentsOf('zh', REPEATS), en: documentsOf('en', REPEATS) };
/** 角度那一步的素材：拿真實頁面的標題當既有內容。 */
const seeds: SeedItem[] = passages
  .filter((p) => p.lang === 'zh')
  .map((p) => ({ title: p.page, excerpt: p.text.slice(0, 120) }))
  .filter((s, i, arr) => arr.findIndex((x) => x.title === s.title) === i)
  .slice(0, 8);
const TOPIC = '蜘蛛結網行為與它的演化';

console.error(
  `語料 ${passages.length} 段｜角度素材 ${seeds.length} 份｜` +
    `抽取文件 中文 ${docs.zh.map((d) => `${d.title} ${d.text.length} 字`).join('、')}｜英文 ${docs.en.map((d) => `${d.title} ${d.text.length} 字`).join('、')}`,
);

const models = only.length > 0 ? only : MODELS_DEFAULT;
/**
 * 哪些模型自己宣告了 `thinking`。**只拿來標記，不拿來過濾。**
 *
 * 宣告是不準的：`granite4.2` 的 capabilities 只有 `completion`，
 * 而它收下 `think: false` 沒有報錯 —— 那一欄的有無不代表它不會思考。
 * 所以 `--no-think` **送給清單上的每一個模型**，宣告只影響標籤。
 */
const thinkingModels = new Set<string>();
{
  const res = await fetch(`${OLLAMA}/api/tags`);
  const body = (await res.json()) as { models?: { name?: string; capabilities?: string[] }[] };
  for (const m of body.models ?? []) {
    if (Array.isArray(m.capabilities) && m.capabilities.includes('thinking')) {
      thinkingModels.add(String(m.name));
    }
  }
}
if (noThink) {
  const declared = models.filter((m) => thinkingModels.has(m));
  console.error(
    `關掉 thinking（全部送）｜自己宣告 thinking 的：${declared.join('、') || '（一個都沒有）'}`,
  );
}

const results: Record<string, unknown>[] = [];

for (const model of models) {
  // 只有「要求關掉」且「這個模型真的宣告會思考」時才送那一欄。
  const think = noThink ? false : null;
  const label = think === false ? `${model} (think:off)` : model;
  console.error(`\n── ${model}`);
  const angles: AnglesRun[] = [];
  for (let i = 0; i < REPEATS; i++) {
    const r = await runAngles(model, TOPIC, seeds, think);
    angles.push(r);
    console.error(
      `  角度 ${i + 1}/${REPEATS}: ${r.schemaOk ? `${r.kept} 條、彼此 ${r.maxPairSimilarity?.toFixed(3) ?? '—'}、離題目 ${r.topicSimilarity?.toFixed(3) ?? '—'}、飄走 ${r.driftedAngles ?? '—'}/${r.kept}` : `失敗（${r.why ?? ''}）`} ${(r.ms / 1000).toFixed(1)}s`,
    );
  }

  const extracts: (ExtractRun & { lang: string })[] = [];
  for (const lang of anglesOnly ? ([] as const) : (['zh', 'en'] as const)) {
    for (let i = 0; i < REPEATS; i++) {
      // **第 i 次用第 i 篇** —— 三次同一篇的話那不是三個樣本。
      const doc = docs[lang][i] ?? docs[lang][0];
      const r = await runExtract(model, doc?.title ?? '', doc?.text ?? '', think);
      extracts.push({ ...r, lang });
      console.error(
        `  抽取 ${lang} ${i + 1}/${REPEATS}: [${r.promptTokens ?? '?'}→${r.evalTokens ?? '?'} tok] ${
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
    model: label,
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
