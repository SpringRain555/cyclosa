/**
 * UI 字串守門 —— **`web/src/` 在 `i18n/` 以外不得出現中文字面值**（REQ-0007）。
 *
 * 用 AST 而不是 regex：只看**字串字面值與樣板字串**，
 * 註解裡的中文不算（這個專案的註解全是中文，用 regex 會全部誤報，
 * 然後有人會把註解改成英文 —— 那是為了讓工具開心而讓人更難讀）。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { rel, REPO_ROOT, ts, walk } from './helpers.js';

const WEB_SRC = join(REPO_ROOT, 'web', 'src');
const CJK = /[㐀-䶿一-鿿豈-﫿]/;

/** `.vue` 的 `<script>` 與 `<template>` 都要看。 */
function sourcesOf(file: string): { text: string; kind: ts.ScriptKind } {
  const raw = readFileSync(file, 'utf8');
  if (!file.endsWith('.vue')) return { text: raw, kind: ts.ScriptKind.TS };
  // template 裡的中文由下面的 templateLiterals 另外檢查
  const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(raw);
  return { text: m?.[1] ?? '', kind: ts.ScriptKind.TS };
}

/** `.vue` 的 `<template>` 區塊原文 —— 這裡的中文一樣不准。 */
function templateOf(file: string): string {
  if (!file.endsWith('.vue')) return '';
  const raw = readFileSync(file, 'utf8');
  const m = /<template[^>]*>([\s\S]*?)<\/template>\s*(?=<script|<style|$)/.exec(raw);
  return m?.[1] ?? '';
}

function stringLiteralsWithCjk(file: string): string[] {
  const { text, kind } = sourcesOf(file);
  if (text.trim().length === 0) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    const isStringish =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node);
    if (isStringish && CJK.test((node as ts.LiteralLikeNode).text)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      found.push(
        `${rel(file)} <script>:${line} ${JSON.stringify((node as ts.LiteralLikeNode).text)}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** template 裡的裸中文：把 mustache、屬性值與 HTML 註解剝掉之後還有 CJK 就是寫死的。 */
function templateCjk(file: string): string[] {
  const tpl = templateOf(file);
  if (tpl.length === 0) return [];
  const stripped = tpl
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/:[\w.-]+="[^"]*"/g, ' ')
    .replace(/@[\w.-]+="[^"]*"/g, ' ')
    .replace(/v-[\w.:-]+="[^"]*"/g, ' ');
  return CJK.test(stripped) ? [`${rel(file)} <template> 裡有寫死的中文`] : [];
}

describe('UI 字串只能來自 i18n', () => {
  const files = walk(WEB_SRC, ['.ts', '.vue']).filter((f) => !f.split(/[\\/]/).includes('i18n'));

  it('至少掃到一些檔案（不然這條測試是死的）', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('沒有任何元件在 script 裡寫死中文', () => {
    expect(files.flatMap(stringLiteralsWithCjk)).toEqual([]);
  });

  it('沒有任何元件在 template 裡寫死中文', () => {
    expect(files.flatMap(templateCjk)).toEqual([]);
  });
});
