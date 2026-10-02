/**
 * 守門：**`src/` 裡的子程序一律不經過 shell**（2026-10-02）。
 *
 * `shell: true` 時 Node 把命令與參數原樣接成一個字串交給 `cmd.exe`（DEP0190）。
 * 這個工具交給子程序的參數裡有提示詞，提示詞裡有專題文件的段落 —— 可能來自抓回來的網頁 ——
 * 而那裡面的 `&`、`|`、`"` 在 `cmd.exe` 眼裡是指令。**那是命令注入**，不是格式問題。
 *
 * 2026-10-02 之前的寫法是「只有 `.cmd`／`.bat` 才走 shell」：預設的 `claude.exe` 沒事，
 * 但使用者只要把指令設成 npm 裝的 `claude.cmd`，那條路就開了。這一條擋兩件事：
 *
 * 1. 任何物件字面值裡的 `shell` 屬性，值都必須是字面的 `false`（`shell: options.shell` 這種也擋 ——
 *    值從哪裡來看不出來，就當成可能是 `true`）
 * 2. 不准從 `child_process` 拿 `exec`／`execSync`（它們**一定**經過 shell）
 *
 * 用 AST 而不是 regex：註解裡的 `shell: true`（例如這一段）不該誤報。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, rel, walk } from './helpers.js';

const SRC = join(REPO_ROOT, 'src');
const ALWAYS_SHELL = new Set(['exec', 'execSync']);

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly what: string;
}

function violationsIn(file: string): Violation[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: Violation[] = [];
  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'shell') {
      if (node.initializer.kind !== ts.SyntaxKind.FalseKeyword) {
        out.push({
          file: rel(file),
          line: lineOf(node),
          what: `shell: ${node.initializer.getText(sf)}`,
        });
      }
    }
    if (ts.isShorthandPropertyAssignment(node) && node.name.getText(sf) === 'shell') {
      out.push({ file: rel(file), line: lineOf(node), what: 'shell（簡寫，值看不出來）' });
    }
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      (node.moduleSpecifier.text === 'node:child_process' ||
        node.moduleSpecifier.text === 'child_process')
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const imported = (el.propertyName ?? el.name).getText(sf);
          if (ALWAYS_SHELL.has(imported)) {
            out.push({
              file: rel(file),
              line: lineOf(el),
              what: `import { ${imported} }（一定經過 shell）`,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

describe('src/ 的子程序不經過 shell', () => {
  const files = walk(SRC);

  it('掃得到檔案（不然這條測試是死的）', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('沒有任何 `shell` 不是字面 false、沒有 exec／execSync', () => {
    expect(files.flatMap(violationsIn)).toEqual([]);
  });

  it('spawn-piped.ts 確實明寫了 `shell: false`（不是靠預設值）', () => {
    const text = readFileSync(join(SRC, 'infrastructure', 'providers', 'spawn-piped.ts'), 'utf8');
    expect(text).toMatch(/shell:\s*false/);
  });
});
