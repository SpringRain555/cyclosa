/**
 * 守門：**前端不把任何字串當 HTML 塞進頁面**（ADR-0039 第三節，v1.1.0）。
 *
 * 閱讀器跟 API 同一個 origin。外來的字（網頁、PDF、Markdown 筆記，甚至模型回的摘要）一旦被當 HTML 塞進頁面，
 * 裡面的腳本就能打 Cyclosa 自己的 API —— ADR-0036 擋的是**別的網頁**送來的請求，擋不了同一頁裡的腳本。
 * Markdown 渲染因此選了「伺服器解析成結構、前端用範本畫」，**沒有消毒器**：安全靠的是根本不產生 HTML。
 * 這一條讓那件事不只是 `MarkdownBlocks.vue` 的寫法，而是整個 `web/src` 的規則。
 *
 * 擋這幾種：範本的 `v-html`；程式裡的 `innerHTML`、`outerHTML`、`insertAdjacentHTML`
 * （讀寫屬性、`el['innerHTML']`、以及 `h('div', { innerHTML })` 這種 render 函式的 props）。
 *
 * 程式用 AST、範本先拿掉 HTML 註解 —— 註解裡提到它們（例如這一段）不該誤報。
 *
 * > 這條規則寫下來的時候對整個 `web/src` 是零命中，而零命中跟規則壞掉長得一模一樣 ——
 * > 所以底下有一條把違規的寫法餵回去，確認判準會紅。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, rel, walk } from './helpers.js';

const WEB_SRC = join(REPO_ROOT, 'web', 'src');
const HTML_SINKS = new Set(['innerHTML', 'outerHTML', 'insertAdjacentHTML']);

/** 一段 TypeScript 裡把字串當 HTML 用的地方（行號從 1 起算）。 */
export function sinksInScript(code: string, offsetLine = 0): number[] {
  const sf = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  const hit = (node: ts.Node): void => {
    lines.push(sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 + offsetLine);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) && HTML_SINKS.has(node.name.text)) hit(node);
    if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      HTML_SINKS.has(node.argumentExpression.text)
    ) {
      hit(node);
    }
    if (
      (ts.isPropertyAssignment(node) ||
        ts.isShorthandPropertyAssignment(node) ||
        ts.isMethodDeclaration(node)) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) &&
      HTML_SINKS.has(node.name.text)
    ) {
      hit(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

/** 範本裡的 `v-html`（HTML 註解拿掉之後）。 */
export function vHtmlInTemplate(template: string): boolean {
  return /(^|[\s<])v-html\b/.test(template.replace(/<!--[\s\S]*?-->/g, ''));
}

interface Violation {
  readonly file: string;
  readonly what: string;
}

function violationsIn(file: string): Violation[] {
  const text = readFileSync(file, 'utf8');
  const out: Violation[] = [];
  if (file.endsWith('.vue')) {
    const template = /<template[\s\S]*<\/template>/.exec(text)?.[0] ?? '';
    if (vHtmlInTemplate(template)) out.push({ file: rel(file), what: 'v-html' });
    for (const m of text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
      const before = text.slice(0, m.index).split('\n').length - 1;
      for (const line of sinksInScript(m[1] ?? '', before)) {
        out.push({ file: rel(file), what: `第 ${String(line)} 行` });
      }
    }
  } else {
    for (const line of sinksInScript(text))
      out.push({ file: rel(file), what: `第 ${String(line)} 行` });
  }
  return out;
}

describe('前端不把字串當 HTML 塞進頁面（ADR-0039）', () => {
  it('web/src 裡沒有 v-html、innerHTML、outerHTML、insertAdjacentHTML', () => {
    const files = walk(WEB_SRC, ['.ts', '.vue']);
    expect(files.length).toBeGreaterThan(10);
    expect(files.flatMap(violationsIn)).toEqual([]);
  });

  it('判準認得出每一種寫法（違規的餵回去要紅）', () => {
    expect(vHtmlInTemplate('<template><div v-html="raw"></div></template>')).toBe(true);
    expect(vHtmlInTemplate('<template><!-- 不用 v-html --><p>{{ x }}</p></template>')).toBe(false);
    expect(sinksInScript('el.innerHTML = s;')).toEqual([1]);
    expect(sinksInScript('el.outerHTML;\nel.insertAdjacentHTML("beforeend", s);')).toEqual([1, 2]);
    expect(sinksInScript("el['innerHTML'] = s;")).toEqual([1]);
    expect(sinksInScript("h('div', { innerHTML: s });")).toEqual([1]);
    expect(sinksInScript('const innerHTML = s;\nh("div", { innerHTML });')).toEqual([2]);
    // 註解與一般字串不算。
    expect(sinksInScript('// el.innerHTML = s\nconst note = "innerHTML";')).toEqual([]);
  });
});
