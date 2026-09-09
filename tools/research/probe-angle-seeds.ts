/**
 * 探針：模型在 `seeds` 那一欄到底填了什麼數字。
 *
 * **它留在 repo 裡是因為它推翻了一個已經寫進文件的結論。**
 * `chat-choice.md` 第一版寫「`translategemma` 的 `seeds` 一個都沒對」，
 * 依據是評測那一輪的 0/18。用這一支換一組素材標題重跑，
 * 同一個模型吐出 `[3] [] [] [0] [2] [4]` —— 三個是對的。
 *
 * 結論因此從「某個模型比較誠實」改成
 * **「這一欄四個都不能信，而且同一個模型換個輸入就變一種樣子」**。
 *
 * 用法：npx tsx tools/research/probe-angle-seeds.ts <模型> [模型 ...]
 */
import {
  ANGLES_SCHEMA,
  ANGLES_SYSTEM,
  anglesUser,
} from '../../src/application/expansion-prompts.js';

const seeds = [
  '蜘蛛',
  '蜘蛛網',
  '光合作用',
  '板塊構造論',
  '知識圖譜',
  'SQLite',
  '區塊鏈',
  '節氣',
].map((t) => ({ title: t, excerpt: `${t}的說明段落。` }));

for (const model of process.argv.slice(2)) {
  const res = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: ANGLES_SYSTEM },
        { role: 'user', content: anglesUser('蜘蛛結網行為與它的演化', seeds) },
      ],
      format: ANGLES_SCHEMA,
      stream: false,
      options: { temperature: 0, num_ctx: 18000 },
    }),
  });
  const b = (await res.json()) as { message?: { content?: string } };
  const parsed = JSON.parse(b.message?.content ?? '{}') as { angles?: { seeds?: unknown }[] };
  const all = (parsed.angles ?? []).map((a) => JSON.stringify(a.seeds));
  console.log(`${model}（有效範圍 1..${seeds.length}）→ ${all.join(' ')}`);
}
