/**
 * `domain/graph` 零依賴（ADR-0014）。
 *
 * 比 `domain/` 的其餘部分**更嚴**：連 `domain/` 的其他資料夾都不能 import。
 *
 * **零依賴是「以後可以抽成套件」的前置條件，而現在維持它的成本幾乎是零。**
 * `rubricator` 是已知的未來消費者 —— 但**現在不抽套件**，
 * 觸發條件是「兩邊的複本已經分岔，而那個分岔造成了一個 bug」。
 *
 * 這條測試存在是因為：**有一天有人會想在裡面用一個 `nanoid`**，
 * 而那一天沒有人會記得這份 ADR。
 */
import { describe, expect, it } from 'vitest';
import { join, relative, sep } from 'node:path';
import { importsOf, rel, REPO_ROOT, walk } from './helpers.js';

const GRAPH_DIR = join(REPO_ROOT, 'src', 'domain', 'graph');

describe('domain/graph 零依賴', () => {
  const files = walk(GRAPH_DIR);

  it('至少掃到一些檔案（不然這條測試是死的）', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('每一個 import 都指向 domain/graph 內部', () => {
    const bad: string[] = [];
    for (const file of files) {
      for (const i of importsOf(file)) {
        // 相對路徑：解析之後必須還在 GRAPH_DIR 底下
        if (i.spec.startsWith('.')) {
          const resolved = join(file, '..', i.spec);
          const outside = relative(GRAPH_DIR, resolved).startsWith('..' + sep);
          if (outside) bad.push(`${rel(i.file)}:${i.line} -> ${i.spec}`);
          continue;
        }
        // 非相對路徑一律不行：npm 套件不行，node: 內建也不行
        bad.push(`${rel(i.file)}:${i.line} -> ${i.spec}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
