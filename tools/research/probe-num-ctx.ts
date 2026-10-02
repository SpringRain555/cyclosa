/**
 * **`num_ctx` 要開多大？** —— 這一支量的是那個數字，不是模型。
 *
 * ## 為什麼需要它
 *
 * `chat-ollama.ts` 送 `num_ctx: REQUIRED_CONTEXT_TOKENS`，而那個常數的來歷是
 * **閘門的門檻**：正文 14,400 ＋ 提示 600 ＋「輸出**大約** 2,000」＝ 約 17,000，取 18,000。
 *
 * 那兩件事被我寫成同一個數字，**而它們不是同一件事**：
 *
 * | | 是什麼 | 太小的下場 |
 * |---|---|---|
 * | 閘門門檻 | 這個模型**夠不夠格**接這個任務 | 擋掉一個其實跑得動的 |
 * | `num_ctx` | 這次請求**配置多大的窗** | 受限解碼中途沒空間，**回一份空字串** |
 *
 * 而「輸出約 2,000」是估的。第一輪 `gemma4:31b` 一次抽出 15 個實體
 * ＋ 10 條**各帶一句引文**的關係 —— 那份 JSON 有沒有超過 2,000 個 token，
 * 在這支跑完之前沒有人知道。
 *
 * ## 它問的問題
 *
 * 同一個模型、同一份正文、同一份 schema，**只改 `num_ctx`**，
 * 每次把 `prompt_eval_count` 與 `eval_count` 印出來。
 * 進去 ＋ 出來如果貼著視窗上緣，那空字串就有解釋了。
 *
 * ## `--unbounded` ＝ 把 schema 的上界拿掉再跑一次
 *
 * `EXTRACT_SCHEMA` 2026-09-09 補上了 `maxItems` 與 `maxLength`。
 * 那個改動要能被反駁，就得跑得出「沒有上界的那一版」——
 * **同一個模型、同一份正文、同一個 `num_ctx`，只差那幾個欄位。**
 * 不然「加上去比較好」只是一句話。
 *
 * 用法：
 *   npx tsx tools/research/probe-num-ctx.ts <語料目錄> <模型> [--unbounded] [num_ctx ...]
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  EXTRACT_SCHEMA,
  EXTRACT_SYSTEM,
  extractUser,
  MAX_TEXT_CHARS,
} from '../../src/application/extraction-prompts.js';

const rawHost = process.env['OLLAMA_HOST'] ?? '127.0.0.1:11434';
const OLLAMA = /^https?:\/\//.test(rawHost) ? rawHost : `http://${rawHost}`;

const argv = process.argv.slice(2);
const unbounded = argv.includes('--unbounded');
const [corpusDir, model, ...ctxArgs] = argv.filter((a) => a !== '--unbounded');
if (corpusDir === undefined || model === undefined) {
  console.error('用法：npx tsx tools/research/probe-num-ctx.ts <語料目錄> <模型> [num_ctx ...]');
  process.exit(2);
}
const contexts = (ctxArgs.length > 0 ? ctxArgs : ['18000', '32768']).map((n) => Number(n));

/**
 * 要送出去的 schema。`--unbounded` 時把兩個陣列的 `maxItems`
 * 與各欄位的長度限制拿掉 —— **那就是 2026-09-09 之前的那一份。**
 */
type Field = Record<string, unknown>;
type Arm = { maxItems?: number; items: { properties: Record<string, Field> } };
const schema = (() => {
  if (!unbounded) return EXTRACT_SCHEMA;
  const clone = JSON.parse(JSON.stringify(EXTRACT_SCHEMA)) as {
    properties: { entities: Arm; relations: Arm };
  };
  for (const key of ['entities', 'relations'] as const) {
    delete clone.properties[key].maxItems;
    for (const field of Object.values(clone.properties[key].items.properties)) {
      delete field['maxLength'];
      delete field['minLength'];
    }
  }
  return clone;
})();

interface Passage {
  readonly lang: 'zh' | 'en';
  readonly page: string;
  readonly text: string;
}
const passages: Passage[] = (await readFile(join(corpusDir, 'corpus.jsonl'), 'utf8'))
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as Passage);

// 跟 `eval-chat.ts` 挑同一份文件：中文、字數最接近上限的那一篇。
const byPage = new Map<string, string[]>();
for (const p of passages.filter((x) => x.lang === 'zh')) {
  byPage.set(p.page, [...(byPage.get(p.page) ?? []), p.text]);
}
let doc = { title: '', text: '' };
for (const [page, parts] of byPage) {
  const joined = parts.join('\n');
  if (Math.abs(joined.length - MAX_TEXT_CHARS) < Math.abs(doc.text.length - MAX_TEXT_CHARS)) {
    doc = { title: page, text: joined };
  }
}
const body = doc.text.slice(0, MAX_TEXT_CHARS);
console.error(
  `模型 ${model}｜正文《${doc.title}》${body.length} 字｜schema ${unbounded ? '**沒有上界**' : '有上界'}\n`,
);

/**
 * **把模型卸掉。** 每一次量測之前都做一次。
 *
 * 2026-09-09 踩到的：同一個模型、同一份正文、同一個 `num_ctx` 連跑三次，
 * `prompt_eval_count` 是 **13,296 / 10,186 / 6,702**。輸入沒有變 ——
 * 變的是**有多少 token 命中了 KV 快取**，而那一欄只算真的算過的。
 * 輸出更誇張（2,400 / 11,474 / 1,595），溫度明明是 0：
 * 快取狀態不同，數值就不同，取樣就會走上不同的路。
 *
 * 所以要嘛全部冷啟動、要嘛全部暖的，**不能混**。這裡選冷的：
 * 它同時也是使用者第一次按下去時會遇到的那一種。
 */
async function unload(): Promise<void> {
  await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [], keep_alive: 0 }),
  });
}

for (const numCtx of contexts) {
  await unload();
  const t0 = performance.now();
  /**
   * **不設上限地等。** 這一支要量的就是「它到底要多久」，
   * 而 Node 的 `fetch` 預設 300 秒收不到回應標頭就丟 `UND_ERR_HEADERS_TIMEOUT` ——
   * Ollama 的非串流回應是**全部生完才送標頭**，所以那個預設會把
   * 「跑超過 300 秒」變成一個看起來像網路故障的例外。
   * 2026-09-09 `gemma4:31b` 在 32768 就是這樣炸掉的，而那本身是一個結果。
   */
  let res: Response;
  try {
    res = await fetch(`${OLLAMA}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM },
          { role: 'user', content: extractUser(doc.title, body) },
        ],
        format: schema,
        stream: false,
        options: { temperature: 0, num_ctx: numCtx },
      }),
    });
  } catch (err) {
    console.log(
      `num_ctx ${String(numCtx).padEnd(7)} **${(performance.now() - t0) / 1000 > 290 ? '超過 300 秒沒有回應' : '請求失敗'}** ${String(err).slice(0, 90)}`,
    );
    continue;
  }
  const ms = performance.now() - t0;
  const json = (await res.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
    done_reason?: string;
  };
  const content = json.message?.content ?? '';
  const inTok = json.prompt_eval_count ?? null;
  const outTok = json.eval_count ?? null;
  const total = inTok !== null && outTok !== null ? inTok + outTok : null;
  let shape = `${content.length} 字`;
  if (content.length > 0) {
    try {
      const v = JSON.parse(content) as {
        entities?: unknown[];
        relations?: { quote?: unknown }[];
      };
      /**
       * **引文的實際長度。** schema 的 `maxLength` 是上限不是目標，
       * 而受限解碼有一種失效方式是「模型被文法逼著把字串填到上限」——
       * 那會讓輸出爆增而內容毫無意義。這一欄直接看得出來。
       */
      const qlen = (v.relations ?? [])
        .map((r) => (typeof r?.quote === 'string' ? r.quote.length : 0))
        .filter((n) => n > 0);
      const qstat =
        qlen.length === 0
          ? ''
          : `、引文 ${Math.round(qlen.reduce((a, b) => a + b, 0) / qlen.length)} 字（最長 ${Math.max(...qlen)}）`;
      shape = `實體 ${v.entities?.length ?? 0}、關係 ${v.relations?.length ?? 0}${qstat}`;
    } catch {
      shape = `不是合法 JSON（${content.length} 字）`;
    }
  }
  console.log(
    `num_ctx ${String(numCtx).padEnd(7)} ` +
      `進 ${String(inTok ?? '?').padEnd(6)} 出 ${String(outTok ?? '?').padEnd(6)} ` +
      `合計 ${String(total ?? '?').padEnd(7)} ` +
      // **視窗用掉幾成。** 貼著上緣的話，空字串就有解釋了。
      `用掉 ${total === null ? '?' : `${Math.round((total / numCtx) * 100)}%`.padEnd(5)} ` +
      `done=${json.done_reason ?? '（沒有這一欄）'} ${(ms / 1000).toFixed(1)}s  ${shape}`,
  );
}
