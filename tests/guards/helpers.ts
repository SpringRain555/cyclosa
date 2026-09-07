/**
 * 守門測試共用的 AST 工具。
 *
 * **用 TypeScript 的 parser 而不是 regex。** 差別是具體的：
 * regex 會把註解裡、字串裡、以及 `import type` 的東西一起算進去，
 * 於是守門測試要嘛誤報（然後被加例外，然後例外變成漏洞），
 * 要嘛漏報（然後它跟一條死掉的測試長得一模一樣）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import ts from 'typescript';

export const REPO_ROOT = join(import.meta.dirname, '..', '..');

export function walk(dir: string, exts: readonly string[] = ['.ts']): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === 'dist') continue;
      out.push(...walk(p, exts));
    } else if (exts.includes(extname(name))) {
      out.push(p);
    }
  }
  return out;
}

export interface ImportRef {
  readonly file: string;
  readonly spec: string;
  readonly typeOnly: boolean;
  readonly line: number;
}

/** 取出一個檔案的所有 import／export-from／dynamic import 的來源字串。 */
export function importsOf(file: string): ImportRef[] {
  const text = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: ImportRef[] = [];

  const lineOf = (node: ts.Node): number =>
    sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push({
        file,
        spec: node.moduleSpecifier.text,
        typeOnly: node.importClause?.isTypeOnly === true,
        line: lineOf(node),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push({
        file,
        spec: node.moduleSpecifier.text,
        typeOnly: node.isTypeOnly,
        line: lineOf(node),
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      out.push({ file, spec: node.arguments[0].text, typeOnly: false, line: lineOf(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** 相對於 repo 根的 POSIX 路徑，讓訊息在 Windows 上也讀得順。 */
export function rel(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

export { ts };
