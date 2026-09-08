/**
 * 會被印到畫面上的中文字串是**純文字**，不是 Markdown。
 *
 * ## 它為什麼存在
 *
 * 這個 repo 的原始碼與文件裡到處都用 `**…**` 強調，而那是寫給讀原始碼的人看的。
 * 一旦那個習慣漏進一個**會被顯示出來的字串**，畫面上就會出現一堆星號 ——
 * Vue 的 `{{ }}` 不解析 Markdown，它就是把那兩個字元印出來。
 *
 * ## 它為什麼要掃第二個檔
 *
 * 第一版（2026-09-08）只掃 `i18n/zh-TW.ts`，而它抓到的六條裡有一條
 * 從 Stage 6 就在那裡。**同一天，同一個錯就在隔壁沒被抓到** ——
 * `catalog.ts` 的 `noteZh` 有七條，而它們一路印到來源網站那一頁上，
 * 直到使用者截圖給我看。
 *
 * **一條只守一個檔的規則，守的不是那條規則，是那個檔。**
 *
 * ## 為什麼 `domain/export/pack.ts` 不在名單上
 *
 * 它產生的是 **Markdown 檔案**，而 `**…**` 在那裡是正確的輸出。
 * 判準不是「這個檔有沒有中文」，是**「這些字會被當成純文字印出來嗎」**。
 *
 * **註解與 JSDoc 不在管轄範圍**：那些本來就是寫給讀原始碼的人看的。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './helpers.js';

/** 會被當成純文字顯示的中文字串住在這幾個檔裡。 */
const FILES: readonly { readonly path: readonly string[]; readonly why: string }[] = [
  { path: ['web', 'src', 'i18n', 'zh-TW.ts'], why: '介面字串' },
  { path: ['src', 'infrastructure', 'sources', 'catalog.ts'], why: '來源網站的名稱與說明' },
];

interface Line {
  readonly file: string;
  readonly n: number;
  readonly line: string;
}

/** 註解那幾行拿掉之後剩下的，就是會被印到畫面上的那些。 */
function valueLines(parts: readonly string[]): readonly Line[] {
  const file = parts[parts.length - 1] ?? '';
  return readFileSync(join(REPO_ROOT, ...parts), 'utf8')
    .split('\n')
    .map((line, i) => ({ file, n: i + 1, line }))
    .filter(({ line }) => {
      const t = line.trim();
      return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
    });
}

const all = FILES.flatMap((f) => valueLines(f.path));

describe('會顯示的中文字串是純文字', () => {
  it('每一個名單上的檔都掃得到內容（不然這條測試是死的）', () => {
    for (const f of FILES) {
      expect(valueLines(f.path).length, f.why).toBeGreaterThan(20);
    }
    expect(all.length).toBeGreaterThan(120);
  });

  it('沒有 Markdown 的粗體標記', () => {
    const bad = all
      .filter(({ line }) => line.includes('**'))
      .map(({ file, n, line }) => `${file}:${String(n)} ${line.trim()}`);
    expect(bad).toEqual([]);
  });

  it('沒有 Markdown 的反引號程式碼標記', () => {
    // 反引號在樣板字串裡是語法的一部分，所以只看**單引號字串裡面**的。
    const bad = all
      .filter(({ line }) => /'[^']*`[^']*'/.test(line))
      .map(({ file, n, line }) => `${file}:${String(n)} ${line.trim()}`);
    expect(bad).toEqual([]);
  });
});
