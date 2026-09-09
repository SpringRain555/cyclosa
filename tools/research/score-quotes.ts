/**
 * **引文找不到的時候，到底是誰的問題？**
 *
 * 「引文命中率」是 `chat` 評測裡最重要的一欄，因為 `locateQuote` 找不到的引文
 * **那條邊就不存在**（ADR-0005）。但那一欄把三件完全不同的事算成同一件：
 *
 * | 真正發生的 | 處方 |
 * |---|---|
 * | 模型**捏造**了一句原文沒有的話 | **換模型** |
 * | 模型逐字照抄，但把 `.` 打成 `。` | **放寬比對**（已做：`findFirstFoldingPunctuation`）|
 * | 模型逐字照抄，但少打一個空格 | 還沒決定 —— 那是更大的放寬 |
 *
 * 這一支拿 `eval-chat.ts` 存下來的**引文原文**，用不同的比對規則各跑一遍，
 * 把那三堆分開數。**跑它不需要 GPU** —— 那正是把引文存下來的理由：
 * 比對規則每改一次就要重跑一小時抽取的話，這個問題永遠不會被回答。
 *
 * 用法：
 *   npx tsx tools/research/score-quotes.ts <chat-results.json> [更多 ...]
 */
import { readFileSync } from 'node:fs';

import { findFirst, findFirstFoldingPunctuation, squash } from '../../src/domain/text/offsets.js';

import { MAX_QUOTE_CHARS, MIN_QUOTE_CHARS } from '../../src/domain/provider/quote.js';

interface ExtractRun {
  readonly quotes?: readonly string[];
  readonly body?: string;
  readonly schemaOk: boolean;
}
interface Entry {
  readonly model: string;
  readonly raw: { readonly extracts: ExtractRun[] };
}

/**
 * 最寬的一種：**空白全部拿掉**，標點折成半形。
 *
 * 這一支只用來**回答「值不值得做」**，不是出貨的規則。
 * 拉丁文的空格是有意義的（`the rapist` 對上 `therapist`），
 * 所以要看的是它比標點正規化多救回幾條 —— 多得有限的話就不值得那個風險。
 */
function foundCjkSpaceOnly(body: string, quote: string): boolean {
  const h = squash(body, false, false, true);
  const n = squash(quote, false, false, true).flat;
  return n.length > 0 && h.flat.includes(n);
}

function foundIgnoringSpaces(body: string, quote: string): boolean {
  const strip = (t: string): string => squash(t, false, true).flat.split(' ').join('');
  return strip(body).includes(strip(quote));
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法：npx tsx tools/research/score-quotes.ts <chat-results.json> [更多 ...]');
  process.exit(2);
}

const entries: Entry[] = [];
for (const f of files) {
  for (const e of JSON.parse(readFileSync(f, 'utf8')) as Entry[]) {
    const at = entries.findIndex((x) => x.model === e.model);
    if (at >= 0) entries.splice(at, 1);
    entries.push(e);
  }
}

const pad = (s: string, n: number): string => {
  let w = 0;
  for (const ch of s) w += /[\u3000-\u9fff\uff00-\uff60]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(1, n - w));
};

console.log(
  pad('model', 30) +
    pad('引文', 7) +
    pad('嚴格', 8) +
    pad('+標點', 9) +
    pad('+CJK空白', 12) +
    pad('+兩者', 10) +
    pad('全去空白', 12) +
    '剩下',
);

const survivors: { model: string; quote: string }[] = [];
for (const e of entries) {
  let total = 0;
  let strict = 0;
  let punct = 0;
  let cjk = 0;
  let both = 0;
  let spaces = 0;
  for (const run of e.raw.extracts) {
    const body = run.body ?? '';
    if (body.length === 0) continue;
    for (const raw of run.quotes ?? []) {
      const q = raw.trim();
      // 長度那兩條先擋掉 —— 它們跟比對規則無關。
      if (q.length < MIN_QUOTE_CHARS || q.length > MAX_QUOTE_CHARS) continue;
      total++;
      const s = findFirst(body, q) !== null;
      const p = findFirstFoldingPunctuation(body, q) !== null;
      const c = s || foundCjkSpaceOnly(body, q);
      const b = findFirstFoldingPunctuation(body, q, true) !== null;
      const sp = foundIgnoringSpaces(body, q);
      if (s) strict++;
      if (p) punct++;
      if (c) cjk++;
      if (b) both++;
      if (sp) spaces++;
      if (!b) survivors.push({ model: e.model, quote: q });
    }
  }
  if (total === 0) continue;
  const pct = (n: number): string => `${n}（${Math.round((n / total) * 100)}%）`;
  console.log(
    pad(e.model, 30) +
      pad(String(total), 7) +
      pad(pct(strict), 8) +
      pad(pct(punct), 9) +
      pad(pct(cjk), 12) +
      pad(pct(both), 10) +
      pad(pct(spaces), 12) +
      String(total - both),
  );
}

console.log('\n=== 連最寬的規則都找不到的（前 8 條）===');
for (const s of survivors.slice(0, 8)) {
  console.log(`[${s.model}] ${JSON.stringify(s.quote.slice(0, 90))}`);
}
