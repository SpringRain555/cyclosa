/**
 * 版本號四邊一致 —— **`package.json`、`changelog.md`、`README.md`、agent 檔。**
 *
 * ## 它為什麼存在
 *
 * v0.4.0 的 commit 訊息、`changelog.md`、`README.md`、兩份 agent 檔
 * 全部寫著 **v0.4.0**，而 `package.json` 停在 **0.3.0**。
 * 沒有任何東西在比對它們，所以那個落差活了一整個階段。
 *
 * 而它不是純粹的美觀問題：`package.json` 的版本號會走到 `/healthz`，
 * 而 **`/healthz` 是單一實例偵測的依據**（ADR-0020）。
 * 「文件說 0.4.0、程式回 0.3.0」是一個沒有人查得出來的矛盾。
 *
 * 形狀跟 `error-codes.test.ts` 一樣：**同一個事實寫在四個地方，
 * 就要有一條測試逼它們一起改。**
 *
 * ## 第四邊是 2026-09-11 才加的，而它是補一個已經發生過的洞
 *
 * 這條測試原本只釘三邊，**而 agent 檔剛好是沒被釘的那一個** ——
 * 於是 `CLAUDE.md` 的「現況」標題一路停在 `v0.5.0`，正文寫著
 * 「筆記與點註、匯出、檢索介面**都還沒有**」，而那三個早就出貨了。
 * 落差活了 **12 個版本**。
 *
 * 那份檔案比另外三份更該被釘住：**它會被自動載入**，所以每一個新對話
 * 都從那個錯的世界觀開始。而它自己下面就寫著「這一節每個階段收尾都要改，
 * 它是整份文件裡最容易變成謊言的一段」—— **知道了，然後沒有人做得到。**
 * 一句提醒攔不住這種東西，一條會紅的測試可以。
 *
 * 只釘標題上那個版本號，**不釘正文**：正文是敘述，機器判斷不了它對不對。
 * 但版本號一動就會逼人回來看那一段，而那正是需要發生的事。
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

describe('版本號四邊一致', () => {
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

  /**
   * **兩份 agent 檔與 `docs/index.md` 的現況標題也對得上。**
   *
   * `docs/index.md` 是同一天加的：它的「現況」停在 **v0.8.0**，
   * 寫著「還沒有的只有語意檢索」—— 而那時已經到 v0.17 了。
   *
   * 這一條守的是一個活了 12 個版本的落差（見檔頭）。兩份都查而不是只查
   * `CLAUDE.md`：`AGENTS.md` 雖然是 `tools\Sync-AgentDocs.ps1` 產生的，
   * 但**忘了跑那支腳本**正是這條測試該抓到的情況之一。
   */
  it.each(['CLAUDE.md', 'AGENTS.md', 'docs/index.md'])('`%s` 的現況標題對得上', (file) => {
    const doc = read(file);
    const found = new RegExp(`## 現況：.*（v(${SEMVER})）`).exec(doc);
    expect(found, `${file} 裡找不到「## 現況：…（vX.Y.Z）」`).not.toBeNull();
    expect(found?.[1], `${file} 的現況標題停在舊版本 —— 那一整節多半也舊了`).toBe(packageVersion);
  });
});
