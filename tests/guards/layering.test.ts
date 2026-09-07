/**
 * 分層守門 —— `domain/` 零 I/O。
 *
 * **它存在的理由**：`domain/` 裝的是真正會出錯的規則（狀態機、墓碑、投影、可信度），
 * 而那些規則要能用純函式測試。一旦有人在裡面 `import 'node:sqlite'`，
 * 那些測試就開始需要一個資料庫，然後就沒有人寫它們了。
 */
import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { importsOf, rel, REPO_ROOT, walk } from './helpers.js';

const DOMAIN = join(REPO_ROOT, 'src', 'domain');

/** `domain/` 不可以碰的東西。 */
const FORBIDDEN_NODE_MODULES = [
  'node:fs',
  'node:fs/promises',
  'node:sqlite',
  'node:http',
  'node:https',
  'node:net',
  'node:child_process',
  'node:os',
  'node:path',
];

/** `domain/` 不可以往上或往旁邊 import 的層。 */
const FORBIDDEN_LAYERS = ['application', 'infrastructure', 'interface'];

describe('domain/ 零 I/O', () => {
  const files = walk(DOMAIN);

  it('至少掃到一些檔案（不然這條測試是死的）', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('不 import 任何 node: 的 I/O 模組', () => {
    const bad = files
      .flatMap(importsOf)
      .filter((i) => FORBIDDEN_NODE_MODULES.includes(i.spec))
      .map((i) => `${rel(i.file)}:${i.line} -> ${i.spec}`);
    expect(bad).toEqual([]);
  });

  it('不 import 其他層', () => {
    const bad = files
      .flatMap(importsOf)
      .filter((i) => FORBIDDEN_LAYERS.some((layer) => i.spec.includes(`/${layer}/`)))
      .map((i) => `${rel(i.file)}:${i.line} -> ${i.spec}`);
    expect(bad).toEqual([]);
  });

  it('不 import 任何 npm 套件（domain 只用語言本身）', () => {
    const bad = files
      .flatMap(importsOf)
      .filter((i) => !i.spec.startsWith('.') && !i.spec.startsWith('node:'))
      .map((i) => `${rel(i.file)}:${i.line} -> ${i.spec}`);
    expect(bad).toEqual([]);
  });
});

describe('interface/ 的 route 不直接碰資料庫', () => {
  const files = walk(join(REPO_ROOT, 'src', 'interface'));

  it('不 import node:sqlite，也不 import infrastructure/db', () => {
    const bad = files
      .flatMap(importsOf)
      .filter((i) => i.spec === 'node:sqlite' || i.spec.includes('/infrastructure/db/'))
      .map((i) => `${rel(i.file)}:${i.line} -> ${i.spec}`);
    expect(bad).toEqual([]);
  });
});
