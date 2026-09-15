/**
 * 守門：**`web/src` 用到的每一個 CSS 變數，都要有人宣告它。**
 *
 * ## 為什麼需要這一條
 *
 * `var(--x)` 讀不到值的時候**不會報錯** —— 那一個屬性安靜地退回初始值：
 * 顏色變成繼承來的、字型變成瀏覽器預設。畫面上看起來只是「有點不一樣」，
 * 而沒有人會把它讀成一個錯。
 *
 * 2026-09-11 掃一次，三個：
 *
 * | 用的 | 該是 | 在哪 |
 * |---|---|---|
 * | `--font-mono` | `--mono` | 設定頁兩處（能力宣告的 context 那一格、任務表）|
 * | `--action-primary` | `--ui-action` | 設定頁的主要按鈕 |
 * | `--text-dim` | `--text-secondary`／`--text-tertiary` | 資料位置分頁（**v0.16.0 新寫的**）|
 *
 * **前兩個在 v0.15.0 就被點名過**，計畫寫著「順手修，legend-coverage 第 2 條
 * 現在就會抓到」—— 而那一條只查**圖例用到的** token，所以它們一直沒被修。
 * 第三個是在那之後才寫的：同一個錯，因為沒有東西守著，又長了一次。
 *
 * > 這條規則寫下來的時候對現況是零命中（三個剛修完），
 * > 所以底下有一條把修掉的寫法餵回去，確認判準會紅（CONVENTIONS §14）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './helpers.js';

const WEB_SRC = join(REPO_ROOT, 'web', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(vue|css)$/.test(p)) out.push(p);
  }
  return out;
}

const USED = /var\(\s*--([a-z0-9-]+)/g;
const DECLARED = /(?:^|[{;\s])--([a-z0-9-]+)\s*:/g;

function usedIn(text: string): Set<string> {
  return new Set([...text.matchAll(USED)].map((m) => m[1] as string));
}
function declaredIn(text: string): Set<string> {
  return new Set([...text.matchAll(DECLARED)].map((m) => m[1] as string));
}

const files = walk(WEB_SRC).map((f) => ({ f, text: readFileSync(f, 'utf8') }));
const declared = new Set(files.flatMap(({ text }) => [...declaredIn(text)]));

describe('CSS 變數', () => {
  it('掃得到東西 —— 一個掃不到變數的檢查永遠會過', () => {
    const used = new Set(files.flatMap(({ text }) => [...usedIn(text)]));
    expect(used.size).toBeGreaterThan(20);
    expect(declared.size).toBeGreaterThan(20);
  });

  it('每一個用到的變數都有人宣告', () => {
    const missing = files.flatMap(({ f, text }) =>
      [...usedIn(text)]
        .filter((name) => !declared.has(name))
        .map((name) => `${f.slice(REPO_ROOT.length + 1)} → --${name}`),
    );
    expect(missing).toEqual([]);
  });

  it('判準認得出被修掉的那三個', () => {
    const before = '.a { font-family: var(--font-mono); color: var(--text-dim); }';
    const names = [...usedIn(before)];
    expect(names).toEqual(['font-mono', 'text-dim']);
    expect(names.filter((n) => !declared.has(n))).toEqual(['font-mono', 'text-dim']);
    expect(declared.has('action-primary')).toBe(false);
    // 而真的宣告過的要被認得。
    expect(declared.has('mono')).toBe(true);
    expect(declared.has('ui-action')).toBe(true);
  });
});
