/**
 * 守門：**架構圖用的顏色，必須是這個 app 真的在用的顏色。**
 *
 * ## 這一條在守什麼
 *
 * `tools/diagrams/mermaid-config.json` 裡有一份 `themeVariables` ——
 * 那是 `docs/architecture/` 底下每一張圖算出來的配色。它是**手抄**的：
 * 有人在建這支腳本的時候從 `tokens.css` 複製了幾個色碼過去。
 *
 * 而 `tokens.css` 之後改過很多次。2026-09-11 回頭對的時候，
 * **七個色碼裡有四個已經不在 `tokens.css` 裡**：
 *
 * | 抄過去的 | 現在是 |
 * |---|---|
 * | `#1a1e26` | `--bg-raised: #1e222b` |
 * | `#e6e8ec` | `--text: #e6e8ee`（差最後一個位元組）|
 * | `#161a21` | `--bg-panel: #171a21`（差一個位元組）|
 * | `#232833` | `--bg-hover: #252a35` |
 *
 * 症狀是九張已提交的 SVG 全部用一組**這個 app 不再使用的顏色**畫成，
 * 而**沒有任何東西會說**：色碼是合法的顏色，圖看起來也很正常。
 * 兩個差一個位元組的更難用眼睛發現。
 *
 * ## 為什麼是「弱形式」
 *
 * 這一條只驗**包含關係**：宣告的每個色碼都要在色票正本裡存在。
 * 它不驗「哪個 token 對應到哪個 `themeVariable`」—— 那是設計判斷，
 * 而且 mermaid 的變數語意（primary／secondary／tertiary）跟這個 app 的
 * 語意層（A／B／C／D／E 層，ADR-0018）**本來就對不起來**。
 *
 * 強形式會逼人寫一份對照表，而那份對照表本身就是第二份會漂的手抄本。
 * 弱形式抓得到真正會發生的那種壞法：**色票改了而這裡沒跟上。**
 *
 * > **同一條規則在 `tagcor-ledger` 與 `webscouts` 各有一份**
 * > （各自對 `ui/colors.py`）。三份是抄的，不是共用套件 ——
 * > 三個 repo 的色票正本格式不同，抽出去會造出一條跨專案相依。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), 'utf8');

/** 一串文字裡所有的 `#rrggbb`，正規化成小寫。 */
function hexesIn(text: string): string[] {
  return [...text.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((m) => m[0].toLowerCase());
}

const config: { themeVariables?: Record<string, unknown> } = JSON.parse(
  read('tools', 'diagrams', 'mermaid-config.json'),
) as { themeVariables?: Record<string, unknown> };

const declared = [...new Set(hexesIn(JSON.stringify(config.themeVariables ?? {})))].sort();

describe('架構圖的配色', () => {
  it('掃得到東西 —— 一個掃不到色碼的檢查永遠會過', () => {
    // 零命中跟規則壞掉長得一模一樣（CONVENTIONS §14）。
    expect(declared.length).toBeGreaterThanOrEqual(5);
  });

  it('每一個色碼都在 tokens.css 裡', () => {
    const palette = new Set(hexesIn(read('web', 'src', 'styles', 'tokens.css')));
    const missing = declared.filter((hex) => !palette.has(hex));
    expect(missing).toEqual([]);
  });

  /**
   * **注入一次真違規。**
   *
   * 上面那一條修完之後對現況是零命中，而零命中跟規則壞掉在測試報告上
   * 長得一模一樣。這一條把 2026-09-11 修掉的那四個色碼餵回去，
   * 確認判準真的認得出來 —— 包含那兩個**只差一個位元組**的。
   */
  it('判準認得出被修掉的那四個色碼', () => {
    const palette = new Set(hexesIn(read('web', 'src', 'styles', 'tokens.css')));
    for (const stale of ['#1a1e26', '#e6e8ec', '#161a21', '#232833']) {
      expect(palette.has(stale), `${stale} 又出現在 tokens.css 裡了`).toBe(false);
    }
  });
});
