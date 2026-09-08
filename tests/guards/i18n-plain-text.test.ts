/**
 * 介面字串是**純文字**，不是 Markdown。
 *
 * ## 它為什麼存在
 *
 * 這個 repo 的原始碼與文件裡到處都用 `**…**` 強調，而那是寫給讀原始碼的人看的。
 * 一旦那個習慣漏進 `i18n/zh-TW.ts` 的**字串值**，畫面上就會出現一堆星號 ——
 * Vue 的 `{{ }}` 不解析 Markdown，它就是把那兩個字元印出來。
 *
 * 2026-09-08 加來源網站那一頁時一次寫進六條，而**其中一條從 Stage 6
 * 就在那裡了**（`reader.noTextLayer`）—— 沒有人發現，因為那條訊息
 * 只在掃描版 PDF 上出現。
 *
 * 星號不會讓任何東西壞掉，所以它可以活很久。這條測試讓它活不過一次 commit。
 *
 * **註解與 JSDoc 不在管轄範圍**：那些本來就是寫給讀原始碼的人看的。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './helpers.js';

const FILE = join(REPO_ROOT, 'web', 'src', 'i18n', 'zh-TW.ts');
const source = readFileSync(FILE, 'utf8');

/** 註解那幾行拿掉之後剩下的，就是會被印到畫面上的那些。 */
const valueLines = source
  .split('\n')
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => {
    const t = line.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  });

describe('i18n 的字串值是純文字', () => {
  it('掃得到內容（不然這條測試是死的）', () => {
    expect(valueLines.length).toBeGreaterThan(100);
  });

  it('沒有 Markdown 的粗體標記', () => {
    const bad = valueLines
      .filter(({ line }) => line.includes('**'))
      .map(({ n, line }) => `zh-TW.ts:${String(n)} ${line.trim()}`);
    expect(bad).toEqual([]);
  });

  it('沒有 Markdown 的反引號程式碼標記', () => {
    // 反引號在樣板字串裡是語法的一部分，所以只看**單引號字串裡面**的。
    const bad = valueLines
      .filter(({ line }) => /'[^']*`[^']*'/.test(line))
      .map(({ n, line }) => `zh-TW.ts:${String(n)} ${line.trim()}`);
    expect(bad).toEqual([]);
  });
});
