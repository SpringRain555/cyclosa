/**
 * 守門：**按鈕、輸入框、標題、表格只在 `base.css` 定義一次；字級只有五級。**
 *
 * ## 這一條在修什麼
 *
 * 2026-09-18 使用者第一次真的用了一輪，說「排版是徹底的災難」。回頭量整個 `web/src`：
 * 19 個 `.vue` 全部在 scoped 樣式裡各自重畫 `button`／`input`，`font-size` 共 **10 種**。
 * 而「儲存」按鈕變成一個看不見字的藍方塊，就是那個習慣的直接後果 ——
 * `SettingsView.vue` 的 scoped 樣式把 `.primary` 的字塗成 `--ui-action`，
 * 全域把底也塗成同一個藍。**兩邊各自都對，合起來讀不到字。**
 *
 * 所以 v0.24.0 起版面的基礎只寫在 `web/src/styles/base.css`，而這一條守兩件事：
 *
 * 1. **scoped 樣式裡不得有以元素開頭的規則**：`button {`、`button.primary {`、
 *    `input[type='text'] {`、`select {`、`h2 {`、`table {`、`th, td {`。
 *    要不一樣就加一個 class、用 `.card button` 這種帶容器的寫法 —— 那是「這個容器裡的
 *    按鈕長這樣」，不是「按鈕長這樣」。
 * 2. **`font-size` 只准是五個 token**（`--fs-title`／`--fs-section`／`--fs-body`／
 *    `--fs-small`／`--fs-label`）或 `inherit`。第六種字級沒有理由存在 —— 而 11px、10px
 *    在使用者的截圖上讀不了。
 *
 * ## 為什麼是靜態檢查
 *
 * 跟 `layout-responsive.test.ts` 同一個理由：真的量要一顆瀏覽器，而這個專案連原生模組都不引。
 * 這裡守的是**寫法**，後果留給 release-checklist 的 D10。
 *
 * > 這條規則寫下來的時候對整個 `web/src` 是零命中（剛全部改完），
 * > 而零命中跟規則壞掉長得一模一樣 —— 所以底下有一條把修掉的寫法餵回去，確認判準會紅。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './helpers.js';

const WEB_SRC = join(REPO_ROOT, 'web', 'src');
const BASE_CSS = join(WEB_SRC, 'styles', 'base.css');
/**
 * **字級那一條的唯一豁免**（v0.24.1）：PDF 版面檢視的文字層是一層透明的字，疊在 pdf.js
 * 畫出來的頁面上；它的字級 ＝ 縮放比例 × 那一段字在 PDF 裡的字高 —— **那是幾何，不是介面的字級**。
 * 豁免只給這一個檔，而且底下有一條釘著它裡面只有那兩行。
 */
const PDF_LAYER_CSS = join(WEB_SRC, 'styles', 'pdf-layer.css');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(vue|css)$/.test(p)) out.push(p);
  }
  return out;
}

/** 只在 `base.css` 定義的那幾個元素。 */
const RESERVED = ['button', 'input', 'select', 'textarea', 'h1', 'h2', 'h3', 'table', 'th', 'td'];

/** 每一條規則的選擇器（逗號分開之後各一條）。**不處理巢狀**，這個 repo 沒有用。 */
function selectorsOf(css: string): string[] {
  const out: string[] = [];
  // 先拿掉註解 —— 註解裡的 `button {` 是在講規則，不是規則。
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const m of clean.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    const head = (m[1] ?? '').trim();
    // `@media (...)` 的開頭不是選擇器。
    if (head.startsWith('@')) continue;
    for (const part of head.split(',')) out.push(part.trim());
  }
  return out;
}

/** 第一個複合選擇器是不是以保留的元素名開頭（`button`、`button.primary`、`th`）。 */
function startsWithReserved(selector: string): boolean {
  const first = selector.split(/[\s>+~]/)[0] ?? '';
  const name = first.match(/^[a-z][a-z0-9]*/)?.[0] ?? '';
  return RESERVED.includes(name);
}

/** `.vue` 檔裡 `<style scoped>` 的內容。 */
function scopedStyleOf(vue: string): string {
  const m = vue.match(/<style[^>]*\bscoped\b[^>]*>([\s\S]*?)<\/style>/);
  return m?.[1] ?? '';
}

const FONT_SIZE = /font-size\s*:\s*([^;}]+)/g;
// `--fs-reading` 跟 `--fs-section` 同一個數字（16），但它是另一個角色：讀長文的字，不是標題。
const ALLOWED_FONT_SIZE = /^(var\(--fs-(title|section|body|small|label|reading)\)|inherit)$/;

const files = walk(WEB_SRC);
const vueFiles = files.filter((f) => f.endsWith('.vue'));

describe('版面的基礎只定義一次', () => {
  it('掃得到東西 —— 一個掃不到檔案的檢查永遠會過', () => {
    expect(vueFiles.length).toBeGreaterThan(10);
    expect(readFileSync(BASE_CSS, 'utf8')).toContain('button.primary');
  });

  it('scoped 樣式裡沒有以 button／input／select／textarea／h1–h3／table／th／td 開頭的規則', () => {
    const bad: string[] = [];
    for (const f of vueFiles) {
      const css = scopedStyleOf(readFileSync(f, 'utf8'));
      for (const selector of selectorsOf(css)) {
        if (startsWithReserved(selector)) {
          bad.push(`${f.slice(REPO_ROOT.length + 1)} → ${selector}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('font-size 只有五個 token（或 inherit）', () => {
    const bad: string[] = [];
    for (const f of files) {
      if (f === BASE_CSS || f === PDF_LAYER_CSS) continue;
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(FONT_SIZE)) {
        const value = (m[1] ?? '').trim();
        if (!ALLOWED_FONT_SIZE.test(value)) {
          bad.push(`${f.slice(REPO_ROOT.length + 1)} → font-size: ${value}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('pdf-layer.css 的豁免很窄：只有文字層那兩行，沒有夾帶介面的字級', () => {
    const found = [...readFileSync(PDF_LAYER_CSS, 'utf8').matchAll(FONT_SIZE)].map((m) =>
      (m[1] ?? '').trim(),
    );
    // 第一個是 `--min-font-size: 1`（pdf.js 的變數名裡剛好有 font-size）。
    expect(found).toEqual(['1', 'calc(var(--text-scale-factor) * var(--font-height))']);
  });

  it('五個 token 都在 base.css 宣告', () => {
    const base = readFileSync(BASE_CSS, 'utf8');
    for (const name of ['title', 'section', 'body', 'small', 'label']) {
      expect(base).toMatch(new RegExp(`--fs-${name}\\s*:\\s*\\d+px`));
    }
  });

  /**
   * **注入一次真違規。** 把 2026-09-18 之前 `SettingsView.vue` 裡那一段
   * （藍字藍底的來源）原封不動餵回去，確認判準認得出來。
   */
  it('判準認得出被修掉的那個寫法', () => {
    const before = `
<style scoped>
button.primary {
  border-color: var(--ui-action);
  color: var(--ui-action);
}
.tabs button {
  font-size: 13px;
}
th,
td {
  padding: 9px 12px;
}
</style>`;
    const selectors = selectorsOf(scopedStyleOf(before));
    expect(selectors.filter(startsWithReserved)).toEqual(['button.primary', 'th', 'td']);
    // `.tabs button` 是「這個容器裡的按鈕」，**不算違規** —— 它以 class 開頭。
    expect(startsWithReserved('.tabs button')).toBe(false);
    expect(startsWithReserved('.compact button')).toBe(false);
    // 而註解裡提到的 `button {` 不算。
    expect(selectorsOf('/* button { } */ .x { }')).toEqual(['.x']);
    // 字級。
    expect(ALLOWED_FONT_SIZE.test('13px')).toBe(false);
    expect(ALLOWED_FONT_SIZE.test('var(--fs-small)')).toBe(true);
  });
});
