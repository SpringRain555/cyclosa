/**
 * `eval-chat.ts` 的記分。**分開的理由是這一步做錯過一次。**
 *
 * 評測腳本給每次呼叫 300 秒，而**出貨給 180 秒**（`CHAT_TIMEOUT_MS`）。
 * 兩個數字不同是刻意的：量到 295 秒比只知道「超過 180 秒」有用得多 ——
 * 它說得出差多少。但**記分一定要照出貨的那一條線**，
 * 否則表上會出現一個「通過」的模型，而使用者按下去只會拿到逾時。
 *
 * 2026-09-09 第一輪我是手算這條線的。手算會漂，所以現在它在這裡，
 * 而且**那個常數是從出貨的程式 import 進來的，不是抄的**。
 *
 * ## 為什麼要分「逾時」與「吐不出東西」
 *
 * 兩種失敗的處方相反：
 *
 * | 失敗 | 看起來 | 怎麼辦 |
 * |---|---|---|
 * | 逾時 | 跑很久然後被砍 | 換小一點的模型、或關掉 thinking |
 * | 吐不出東西 | 幾秒內回 0 個字元 | **這個模型不能用**，換再久也一樣 |
 *
 * 合成一欄「通過率」的話這兩件事看起來一模一樣。
 *
 * 用法：
 *   npx tsx tools/research/score-chat.ts <chat-results.json> [更多 ...]
 */
import { readFileSync } from 'node:fs';

import { CHAT_TIMEOUT_MS } from '../../src/infrastructure/providers/chat-ollama.js';

interface AnglesRun {
  readonly schemaOk: boolean;
  readonly kept: number;
  readonly seedRefsValid: number;
  readonly seedRefsTotal: number;
  readonly maxPairSimilarity: number | null;
  readonly topicSimilarity: number | null;
  readonly driftedAngles: number | null;
  readonly ms: number;
  readonly why: string | null;
  readonly sample: readonly string[];
}

interface ExtractRun {
  readonly schemaOk: boolean;
  readonly entities: number;
  readonly relations: number;
  readonly quotesFound: number;
  readonly typeSpread: number;
  readonly ms: number;
  readonly why: string | null;
  readonly lang: string;
}

interface Entry {
  readonly model: string;
  readonly raw: { readonly angles: AnglesRun[]; readonly extracts: ExtractRun[] };
  readonly angles: { readonly samples: readonly string[] };
}

/** **出貨的那條線。** 跑得出東西但超過它 ＝ 使用者拿到的是逾時。 */
const inBudget = (r: { schemaOk: boolean; ms: number }): boolean =>
  r.schemaOk && r.ms <= CHAT_TIMEOUT_MS;

function mean(xs: readonly number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pad(s: string, n: number): string {
  // 中日韓字元在等寬字型裡佔兩格 —— 不算進去的話表格會歪。
  let w = 0;
  for (const ch of s) w += /[\u3000-\u9fff\uff00-\uff60]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(1, n - w));
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法：npx tsx tools/research/score-chat.ts <chat-results.json> [更多 ...]');
  process.exit(2);
}

const entries: Entry[] = [];
for (const f of files) {
  for (const e of JSON.parse(readFileSync(f, 'utf8')) as Entry[]) {
    // 同一個模型出現在兩個檔裡時，**後面的蓋掉前面的** —— 重跑的才是現在的事實。
    const at = entries.findIndex((x) => x.model === e.model);
    if (at >= 0) entries.splice(at, 1);
    entries.push(e);
  }
}

console.log(`記分線：${CHAT_TIMEOUT_MS / 1000} 秒（出貨的 CHAT_TIMEOUT_MS）\n`);

console.log(
  pad('model', 26) +
    pad('角度', 8) +
    pad('條數', 7) +
    pad('彼此', 8) +
    pad('離題目', 9) +
    pad('飄走', 7) +
    pad('seed有效', 11) +
    '秒',
);
for (const e of entries) {
  const runs = e.raw.angles;
  const ok = runs.filter(inBudget);
  const refsTotal = ok.reduce((s, a) => s + a.seedRefsTotal, 0);
  const refsValid = ok.reduce((s, a) => s + a.seedRefsValid, 0);
  const sims = ok.map((a) => a.maxPairSimilarity).filter((v): v is number => v !== null);
  /**
   * **這兩欄一定要一起看。**
   *
   * 只看「彼此」會選出一個亂發散的模型 —— **胡說八道彼此當然不像。**
   * 2026-09-09 實測：`olmo-3:32b-think` 的「彼此」最好（0.681），
   * 而它問的是「蜘蛛結網行為的演化如何與其**光合作用能力**的發展相關」；
   * `translategemma:12b` 的「彼此」最差（0.802），三條全部切題。
   *
   * 失效的機制看得出來：素材是語料裡**別的頁面的標題**，
   * 而有些模型把素材的主題當成了這個專題的角度。
   * 「離題目」就是那件事的數字 —— 低就是飄走了。
   */
  const topics = ok.map((a) => a.topicSimilarity).filter((v): v is number => v !== null);
  console.log(
    pad(e.model, 26) +
      pad(`${ok.length}/${runs.length}`, 8) +
      pad(ok.length === 0 ? '—' : mean(ok.map((a) => a.kept)).toFixed(1), 7) +
      pad(sims.length === 0 ? '—' : mean(sims).toFixed(3), 8) +
      pad(topics.length === 0 ? '—' : mean(topics).toFixed(3), 9) +
      pad(
        ok.length === 0
          ? '—'
          : `${ok.reduce((a, x) => a + (x.driftedAngles ?? 0), 0)}/${ok.reduce((a, x) => a + x.kept, 0)}`,
        7,
      ) +
      pad(refsTotal === 0 ? '—' : `${Math.round((refsValid / refsTotal) * 100)}%`, 11) +
      `${Math.round(mean(runs.map((a) => a.ms)) / 1000)}s`,
  );
}

console.log(
  '\n' +
    pad('model', 26) +
    pad('抽取', 8) +
    pad('實體', 7) +
    pad('關係', 7) +
    pad('引文命中', 11) +
    pad('型別', 6) +
    pad('秒', 7) +
    '失敗的樣子',
);
for (const e of entries) {
  const runs = e.raw.extracts;
  const ok = runs.filter(inBudget);
  const rels = ok.reduce((s, x) => s + x.relations, 0);
  const found = ok.reduce((s, x) => s + x.quotesFound, 0);
  /**
   * **兩種失敗分開數，而且順序不能反。**
   *
   * 評測給 300 秒，被砍的那一次同樣是 `schemaOk: false` ——
   * 先問 `schemaOk` 的話，**一次逾時會被記成「吐不出東西」**，
   * 而那兩件事的處方相反。2026-09-09 第一版就是這樣寫的，
   * 於是 `gemma4:31b` 的三次逾時被算進了「吐不出」那一欄。
   *
   * 所以先看時間：**超過出貨那條線的，不管它後來吐了什麼，都是逾時。**
   */
  const late = runs.filter((x) => x.ms > CHAT_TIMEOUT_MS).length;
  const broke = runs.filter((x) => !x.schemaOk && x.ms <= CHAT_TIMEOUT_MS).length;
  const shape = [late > 0 ? `逾時 ${late}` : '', broke > 0 ? `吐不出 ${broke}` : '']
    .filter((s) => s.length > 0)
    .join('、');
  console.log(
    pad(e.model, 26) +
      pad(`${ok.length}/${runs.length}`, 8) +
      pad(ok.length === 0 ? '—' : mean(ok.map((x) => x.entities)).toFixed(1), 7) +
      pad(ok.length === 0 ? '—' : mean(ok.map((x) => x.relations)).toFixed(1), 7) +
      pad(rels === 0 ? '—' : `${Math.round((found / rels) * 100)}%`, 11) +
      pad(ok.length === 0 ? '—' : mean(ok.map((x) => x.typeSpread)).toFixed(1), 6) +
      pad(`${Math.round(mean(runs.map((x) => x.ms)) / 1000)}s`, 7) +
      (shape.length === 0 ? '—' : shape),
  );
}

console.log('\n=== 角度樣本 ===');
for (const e of entries) {
  console.log(`[${e.model}]`);
  for (const q of e.angles.samples) console.log(`  · ${q}`);
}
