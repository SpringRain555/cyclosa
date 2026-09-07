/**
 * 靜態檔的路徑圍堵。
 *
 * **這條測試是「不引 `@fastify/static`」那個決定的代價。**
 * 自己做路徑圍堵就要自己驗它，而且要用真的穿越字串驗，不是看程式碼覺得對。
 */
import { describe, expect, it } from 'vitest';
import { resolve, sep } from 'node:path';
import { safeResolve } from '../../src/interface/http/static.js';

const ROOT = resolve('/srv/web');

describe('safeResolve 的路徑圍堵', () => {
  it('正常路徑解得出來', () => {
    expect(safeResolve(ROOT, '/index.html')).toBe(resolve(ROOT, 'index.html'));
    expect(safeResolve(ROOT, '/assets/app.js')).toBe(resolve(ROOT, 'assets', 'app.js'));
  });

  it.each([
    '/../secret',
    '/../../etc/passwd',
    '/assets/../../secret',
    '/..%2fsecret',
    '/%2e%2e/secret',
    '/%2e%2e%2f%2e%2e%2fsecret',
  ])('擋掉穿越：%s', (path) => {
    expect(safeResolve(ROOT, path)).toBeNull();
  });

  it('擋掉 null byte', () => {
    expect(safeResolve(ROOT, '/index.html%00.png')).toBeNull();
  });

  it('壞掉的 percent-encoding 直接拒絕，不是丟例外', () => {
    expect(safeResolve(ROOT, '/%zz')).toBeNull();
  });

  it('**前綴檢查要帶分隔符號** —— 兄弟目錄不算在裡面', () => {
    // `/srv/web-evil` 的前綴是 `/srv/web`，但它不在 `/srv/web` 底下
    const sibling = safeResolve(ROOT, '/../web-evil/x');
    expect(sibling).toBeNull();
  });

  it('根目錄本身可以', () => {
    expect(safeResolve(ROOT, '/')).toBe(ROOT);
  });

  it('解出來的一定在 root 底下', () => {
    for (const p of ['/a', '/a/b/c.js', '/中文.html']) {
      const r = safeResolve(ROOT, p);
      expect(r).not.toBeNull();
      expect(r === ROOT || r!.startsWith(ROOT + sep)).toBe(true);
    }
  });
});
