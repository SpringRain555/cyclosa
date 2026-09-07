/**
 * 第五條守門：**沒有整圖端點，而且前端沒有地方在呼叫它**（ADR-0008）。
 *
 * 「有了整圖端點，前端遲早會呼叫它，然後在 8k 節點時死掉」——
 * 那句話的前半在後端守（那條路由不存在，`tests/e2e/graph-flow.test.ts` 驗 404），
 * **後半在這裡守**：前端原始碼裡不得出現任何指向整圖的 API 路徑。
 *
 * ## 為什麼不是直接 grep 「graph」
 *
 * 那會抓到一堆不是端點的東西：元件名 `GraphView`、路由 `/case/:slug/graph`
 * （那是畫面網址不是 API）、CSS class、註解。
 * **一條會誤報的守門測試遲早會被加例外，而例外會變成漏洞**（`helpers.ts`）。
 *
 * 所以判準寫得很窄：**以 `/api/` 開頭、以 `/graph` 或 `/graph?` 結尾的字串字面值**。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { rel, REPO_ROOT, ts, walk } from './helpers.js';

const WEB_SRC = join(REPO_ROOT, 'web', 'src');
const SRC = join(REPO_ROOT, 'src');

/** `/api/…/graph`，但不是 `/api/…/subgraph`。 */
const WHOLE_GRAPH = /^\/api\/.*(?<!sub)\/graph(\?|$)/;

function scriptOf(file: string): string {
  const raw = readFileSync(file, 'utf8');
  if (!file.endsWith('.vue')) return raw;
  return /<script[^>]*>([\s\S]*?)<\/script>/.exec(raw)?.[1] ?? '';
}

function wholeGraphLiterals(file: string): string[] {
  const text = scriptOf(file);
  if (text.trim().length === 0) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];

  const visit = (node: ts.Node): void => {
    const stringish =
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node);
    if (stringish && WHOLE_GRAPH.test((node as ts.LiteralLikeNode).text)) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      found.push(`${rel(file)}:${line} ${JSON.stringify((node as ts.LiteralLikeNode).text)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

describe('沒有整圖端點（ADR-0008）', () => {
  const webFiles = walk(WEB_SRC, ['.ts', '.vue']);
  const serverFiles = walk(SRC, ['.ts']);

  it('至少掃到一些檔案（不然這條測試是死的）', () => {
    expect(webFiles.length).toBeGreaterThan(0);
    expect(serverFiles.length).toBeGreaterThan(0);
  });

  it('前端沒有任何字串指向整圖端點', () => {
    expect(webFiles.flatMap(wholeGraphLiterals)).toEqual([]);
  });

  it('後端也沒有登記那樣一條路由', () => {
    expect(serverFiles.flatMap(wholeGraphLiterals)).toEqual([]);
  });

  /**
   * 上面兩條是否定測試，而**否定測試最容易悄悄變成死的** ——
   * 正則寫錯一個字，它就永遠回空陣列而且永遠是綠的。
   * 所以這一條餵一個真的違規進去，確認它抓得到。
   */
  it('這條規則本身是活的 —— 餵一個違規給它會抓到', () => {
    expect(WHOLE_GRAPH.test('/api/cases/x/graph')).toBe(true);
    expect(WHOLE_GRAPH.test('/api/cases/x/graph?hops=2')).toBe(true);
    // 子圖是合法的，不能被誤報
    expect(WHOLE_GRAPH.test('/api/cases/x/subgraph')).toBe(false);
    expect(WHOLE_GRAPH.test('/api/cases/x/subgraph?focus=a')).toBe(false);
    // 畫面網址不是 API
    expect(WHOLE_GRAPH.test('/case/x/graph')).toBe(false);
  });
});
