/**
 * 守門：**圖例上的每一行都要指得到一個真的東西。**
 *
 * ## 它守的是一件真的發生過的事
 *
 * v0.3.0 的圖例上寫著「已否決（打叉）」——**而那個叉根本沒實作**，
 * 因為當時沒有任何路徑可以否決一條邊。發版檢查表的 D8 就是為那件事寫的：
 * 「圖例上的每一行，在合成資料裡都要有一個實例。沒有實例的那一行
 * 等於一句沒有人驗證過的宣稱。」
 *
 * D8 是人工項（要看截圖）。這一條是它機器驗得到的那一半：
 *
 * 1. 宣告裡的每一種關聯畫法，`domain/graph/render-rules.ts` 裡真的有
 * 2. 宣告裡的每一個顏色 token，`tokens.css` 裡真的有
 * 3. 宣告裡的每一個 key，`zh-TW.ts` 裡真的有一段文字
 * 4. 每個 `mark` 的 CSS class，`legend-marks.css` 裡真的畫得出來
 *
 * ## 第 1 條為什麼要用逐字比對
 *
 * `web/` 是另一份建置，它自己宣告一份 `EdgeDrawingName`。
 * **`tsc` 對「兩份建置各自宣告的同一個東西」什麼都不會說**
 * （`docs/lessons.md`：「改掉一個跨建置的欄位名，762 個測試全綠」）。
 * 所以這裡把兩邊都讀進來比。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LEGEND_SECTIONS } from '../../web/src/components/graph/legend-items.js';
import { nodeGlyphFor } from '../../src/domain/graph/render-rules.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

const items = LEGEND_SECTIONS.flatMap((s) => s.items);

/**
 * `domain` 那一份畫法清單。**掃原始碼而不是 import 一個常數陣列** ——
 * 那個型別的每一個值上面都有一行說明它為什麼長那樣，
 * 而把它改寫成 `as const` 陣列會把那些說明擠掉。
 * 這個 repo 的其他守門測試（`chat-tasks`、`recommended-models`）用同一招。
 */
function drawingsInDomain(): string[] {
  const src = read('src', 'domain', 'graph', 'render-rules.ts');
  const start = src.indexOf('export type EdgeDrawing =');
  expect(start, '`EdgeDrawing` 的宣告不見了').toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf(';', start));
  return [...block.matchAll(/'([a-z]+)'/g)].map((m) => m[1] as string);
}

describe('圖例宣告與它指向的東西', () => {
  it('書目的資料藍虛線有圖例，且圖上與設定頁都涵蓋', () => {
    const section = LEGEND_SECTIONS.find((entry) => entry.key === 'nodes');
    const reference = section?.items.find((entry) => entry.key === 'nodeReference');
    expect(section?.compact).toBe(true);
    expect(reference).toMatchObject({
      mark: 'swatch reference',
      tokens: ['--node-item'],
      compact: true,
    });
    expect(nodeGlyphFor({ kind: 'item', itemKind: 'reference' })).toMatchObject({
      fill: 'item',
      dashed: true,
    });
  });
  it('每一種關聯畫法都對得上 domain 的那一份，而且沒有多也沒有少', () => {
    const declared = new Set(items.map((i) => i.drawing).filter((d) => d !== undefined));
    // **雙向。** 只查一邊的話，一份「只是子集」的圖例照樣會綠 ——
    // 而少掉的那一種畫法會安靜地沒有人解釋。
    expect([...declared].sort()).toEqual(drawingsInDomain().sort());
  });

  it('每一個顏色 token 都真的存在於 tokens.css', () => {
    const css = read('web', 'src', 'styles', 'tokens.css');
    const missing = [...new Set(items.flatMap((i) => i.tokens))].filter(
      (name) => !css.includes(`${name}:`),
    );
    expect(missing).toEqual([]);
  });

  it('每一個 mark 的 class 都真的畫得出來', () => {
    const css = read('web', 'src', 'styles', 'legend-marks.css');
    const classes = [...new Set(items.flatMap((i) => i.mark.split(' ')))].filter(
      (c) => c.length > 0,
    );
    const missing = classes.filter((c) => !css.includes(`.mark.${c}`));
    expect(missing).toEqual([]);
  });

  it('每一個 key 都有 short 與 long 兩段文字，而且都不是空的', () => {
    const i18n = read('web', 'src', 'i18n', 'zh-TW.ts');
    const guide = i18n.slice(i18n.indexOf('    guide: {'), i18n.indexOf('    selection: {'));
    for (const item of items) {
      expect(guide, item.key).toContain(`${item.key}: {`);
    }
    for (const section of LEGEND_SECTIONS) {
      expect(guide, section.key).toContain(`${section.key}: '`);
    }
  });

  it('圖上那一欄是完整版的子集，不是自己的一份', () => {
    // `compact` 只是一個旗標，所以這一條問的是「有沒有人偷偷加了一行」。
    const compactKeys = LEGEND_SECTIONS.flatMap((s) =>
      s.compact ? s.items.filter((i) => i.compact).map((i) => i.key) : [],
    );
    const all = new Set(items.map((i) => i.key));
    expect(compactKeys.filter((k) => !all.has(k))).toEqual([]);
    // **而且它不能是空的** —— 一個空的圖例不會有人發現，圖照樣畫得出來。
    expect(compactKeys.length).toBeGreaterThan(8);
  });

  it('每個 key 只出現一次', () => {
    const keys = items.map((i) => i.key);
    expect(keys.length).toBe(new Set(keys).size);
  });
});
