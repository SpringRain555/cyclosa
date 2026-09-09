/**
 * 探針：一個模型在**多長的正文**之下還守得住 `EXTRACT_SCHEMA`。
 *
 * **它留在 repo 裡是因為它是一個結論的證據**（比照 `probe-markers.ts`）：
 * 2026-09-09 `nemotron-cascade-2:30b` 的抽取六次全部回 0 個字元，
 * 而用這一支逐段加長之後看到它**斷在 500 到 800 個字元之間** ——
 * 而它的 context 是 262144，所以那跟 context 無關。
 * 失敗時回來的物件還少了 `done_reason` 與 `eval_count`。
 *
 * 下一次有人想「這個模型宣告 json_schema: true，應該可以吧」的時候，先跑這一支。
 *
 * 用法：npx tsx tools/research/probe-schema-limit.ts <模型>
 */
import {
  EXTRACT_SCHEMA,
  EXTRACT_SYSTEM,
  extractUser,
} from '../../src/application/expansion-prompts.js';

const SHORT =
  '塵蛛屬（Cyclosa）是金蛛科的一個屬。牠們會在網上放置碎屑裝飾。研究者在台中的烏石坑觀察到這個行為。';
const model = process.argv[2] ?? 'nemotron-cascade-2:30b';

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
