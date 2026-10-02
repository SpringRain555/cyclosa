/**
 * 探針：一個模型在**多長的正文**之下還守得住 `EXTRACT_SCHEMA`。
 *
 * **它留在 repo 裡是因為它是一個結論的證據**（比照 `probe-markers.ts`）：
 * 2026-09-09 `nemotron-cascade-2:30b` 的抽取六次全部回 0 個字元，
 * 而用這一支逐段加長之後看到它**斷在 500 到 800 個字元之間** ——
 * 而它的 context 是 262144，所以那跟 context 無關。
 * 失敗時回來的物件還少了 `done_reason` 與 `eval_count`。
 *
 * ## 而那個結論的**解釋**當時是錯的
 *
 * 當時寫的是「合理的解釋是受限解碼在 `nemotron_h_moe` 這個架構上
 * 沒有被完整支援」。**同一天稍後量到的是：關掉思考它就好了**
 * （抽取 0/6 → 6/6）。所以斷掉的是思考，不是文法。
 *
 * 這一支現在收 `--no-think`，就是為了讓那件事**下次能被直接問出來**，
 * 而不是又留下一個聽起來合理的架構猜測。
 *
 * 用法：npx tsx tools/research/probe-schema-limit.ts <模型> [--no-think]
 */
import {
  EXTRACT_SCHEMA,
  EXTRACT_SYSTEM,
  extractUser,
} from '../../src/application/extraction-prompts.js';

const SHORT =
  '塵蛛屬（Cyclosa）是金蛛科的一個屬。牠們會在網上放置碎屑裝飾。研究者在台中的烏石坑觀察到這個行為。';
const argv = process.argv.slice(2);
/** 出貨的 `chat-ollama.ts` 會送 `think: false`，所以這一欄要能開。 */
const noThink = argv.includes('--no-think');
const model = argv.filter((a) => a !== '--no-think')[0] ?? 'nemotron-cascade-2:30b';
console.error(`模型 ${model}｜思考 ${noThink ? '關' : '照模型預設'}`);

for (const len of [200, 500, 800, 1200, 2000]) {
  const body = SHORT.repeat(Math.ceil(len / SHORT.length)).slice(0, len);
  const t0 = Date.now();
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: extractUser('測試', body) },
      ],
      format: EXTRACT_SCHEMA,
      stream: false,
      ...(noThink ? { think: false } : {}),
      options: { temperature: 0, num_ctx: 18000 },
    }),
  });
  const b = (await res.json()) as Record<string, unknown>;
  const c = ((b['message'] as { content?: string } | undefined)?.content ?? '') as string;
  console.log(
    `${len} 字 → 回應 ${c.length} 字（${((Date.now() - t0) / 1000).toFixed(1)}s）done_reason=${String(b['done_reason'])} eval_count=${String(b['eval_count'])}`,
  );
  if (c.length === 0) console.log(`   原始回應的欄位：${Object.keys(b).join(', ')}`);
}
