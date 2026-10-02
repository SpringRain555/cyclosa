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
 * | 延遲 | 本機模型沒有金額成本，時間就是全部的成本 |
 *
 * **引文命中率是這一份最重要的一欄。** 它直接量「模型有沒有捏造原文」，
 * 而且它是機器判的 —— 不需要任何人去讀輸出。
 *
 * ## 走的是真的會出貨的那幾支
 *
 * 提示詞用 `application/extraction-prompts.ts`、正規化用 `domain/provider/`、
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
  normalizeExtraction,
  REQUIRED_CONTEXT_TOKENS,
} from '../../src/domain/provider/index.js';
import {
  EXTRACT_SCHEMA,
  EXTRACT_SYSTEM,
  extractUser,
  MAX_TEXT_CHARS,
} from '../../src/application/extraction-prompts.js';

const rawHost = process.env['OLLAMA_HOST'] ?? '127.0.0.1:11434';
const OLLAMA = /^https?:\/\//.test(rawHost) ? rawHost : `http://${rawHost}`;

/** 每個任務重複幾次。**一次跑不出「穩不穩定」**，而穩定性正是這裡要問的。 */
const REPEATS = 3;

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

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
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
if (argv.includes('--angles-only')) {
  console.error('角度流程已退場，這支工具只量抽取。');
  process.exit(2);
}
const [corpusDir, outDir, ...only] = argv.filter(
  (a) => a !== '--no-think' && a !== '--extract-only',
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

console.error(
  `語料 ${passages.length} 段｜` +
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
  const extracts: (ExtractRun & { lang: string })[] = [];
  for (const lang of ['zh', 'en'] as const) {
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

  const okExtracts = extracts.filter((e) => e.schemaOk);
  const totalRels = okExtracts.reduce((s, e) => s + e.relations, 0);
  const totalFound = okExtracts.reduce((s, e) => s + e.quotesFound, 0);

  results.push({
    model: label,
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
    raw: { extracts },
  });
}

await writeFile(join(outDir, 'chat-results.json'), JSON.stringify(results, null, 2) + '\n', 'utf8');
console.error(`\n寫到 ${join(outDir, 'chat-results.json')}`);
