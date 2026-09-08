/**
 * 版本號三邊一致 —— **`package.json`、`changelog.md`、`README.md`。**
 *
 * ## 它為什麼存在
 *
 * Stage 8 的 commit 訊息、`changelog.md`、`README.md`、兩份 agent 檔
 * 全部寫著 **v0.4.0**，而 `package.json` 停在 **0.3.0**。
 * 沒有任何東西在比對它們，所以那個落差活了一整個階段。
 *
 * 而它不是純粹的美觀問題：`package.json` 的版本號會走到 `/healthz`，
 * 而 **`/healthz` 是單一實例偵測的依據**（ADR-0020）。
 * 「文件說 0.4.0、程式回 0.3.0」是一個沒有人查得出來的矛盾。
 *
 * 形狀跟 `error-codes.test.ts` 一樣：**同一個事實寫在三個地方，
 * 就要有一條測試逼它們一起改。**
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './helpers.js';

const SEMVER = String.raw`\d+\.\d+\.\d+`;

function read(...parts: string[]): string {
  return readFileSync(join(REPO_ROOT, ...parts), 'utf8');
}

/** `package.json` 是版本號的**單一真實來源** —— 另外兩邊是它的說明。 */
const packageVersion = (JSON.parse(read('package.json')) as { version: string }).version;

describe('版本號三邊一致', () => {
  it('`package.json` 的版本號長得像一個版本號', () => {
    expect(packageVersion).toMatch(new RegExp(`^${SEMVER}$`));
  });

  it('`changelog.md` 的「目前是」那一行對得上', () => {
    const changelog = read('docs', 'changelog.md');
    const current = new RegExp(`目前是 \\*\\*v(${SEMVER})\\*\\*`).exec(changelog);
    expect(current, '`changelog.md` 裡找不到「目前是 **vX.Y.Z**」那一行').not.toBeNull();
    expect(current?.[1]).toBe(packageVersion);
  });

  it('`changelog.md` 最上面那一節就是這一版', () => {
    const changelog = read('docs', 'changelog.md');
    const first = new RegExp(`^## v(${SEMVER})`, 'm').exec(changelog);
    expect(first, '`changelog.md` 裡找不到任何 `## vX.Y.Z` 標題').not.toBeNull();
    // **最新的一節要在最上面** —— 這一條同時擋住「寫了新的一節但插在中間」
    expect(first?.[1]).toBe(packageVersion);
  });

  it('`README.md` 的現況標題對得上', () => {
    const readme = read('README.md');
    const found = new RegExp(`## 現況：.*（v(${SEMVER})）`).exec(readme);
    expect(found, '`README.md` 裡找不到「## 現況：…（vX.Y.Z）」').not.toBeNull();
    expect(found?.[1]).toBe(packageVersion);
  });
});
