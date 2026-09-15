/**
 * 守門：**錯誤訊息叫人去按的每一顆按鈕，都要真的在畫面上。**
 *
 * ## 它守的是一件發生過兩次的事
 *
 * `CASE_NOT_FOUND` 與 `CASE_FOLDER_EXISTS` 的訊息都寫著
 * 「用『開啟既有資料夾』」—— 而那顆按鈕背後的 `POST /api/cases/open`
 * **從來沒有被實作過**，畫面上也沒有畫出來。
 *
 * 一句叫人去按一顆不存在的按鈕的訊息，比沒有建議更糟：
 * 使用者會花時間找那顆按鈕，然後懷疑是自己漏看了。
 * 而 `CASE_NOT_FOUND` 在 2026-09-11 之前幾乎沒有人看得到
 * （十幾支端點在那個情況下回的是 `IO_UNEXPECTED`）—— 修好那個之後，
 * **這句錯話就從一句沒人讀的字變成一句每個人都會讀到的字。**
 *
 * ## 判準是「被元件用到」，不是「字串存在」
 *
 * 第一版的判準是「那個標籤在 `zh-TW.ts` 裡有出現」，而**它會放過原本那個錯** ——
 * 因為 `zh-TW.ts` 裡真的有一個 `openExisting: '開啟既有資料夾'`，
 * 只是沒有任何元件用到它。**一個孤兒 key 讓一顆不存在的按鈕看起來存在。**
 * 所以這裡要求：那個標籤對應的 key，要以 `t.<路徑>` 的形式出現在某個元件裡。
 *
 * ## 只看「叫人去操作」的引用
 *
 * 錯誤訊息裡的「」不全是按鈕 —— 「任職於」「收購」是關係型別的舉例。
 * 對全部的「」查的話，**7 個裡有 4 個是誤報**（2026-09-11 實測）。
 * 只看動詞後面接的那種（用／按／到／點選／從「…」），**現況零誤報**。
 * `「設定 → 資料位置」` 這種路徑寫法會拆開逐段查。
 *
 * > **動詞清單原本有單字的「點」，而它在同一天就誤報了一次。**
 * > v0.18.0 新寫的 `PROVIDER_JSON_UNSUPPORTED` 是「這個模型在這個**端點**上連
 * > 『回一份 JSON』都不保證」—— 「端點」的「點」被讀成了「點一下」。
 * > 「點」在中文裡太常當名詞的一半（端點、重點、地點），所以改成只認「點選」。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { errorMessages, t } from '../../web/src/i18n/zh-TW.js';
import { REPO_ROOT } from './helpers.js';

const WEB_SRC = join(REPO_ROOT, 'web', 'src');
const I18N_FILE = join(WEB_SRC, 'i18n', 'zh-TW.ts');

/** 動詞後面接的「」—— 那才是在叫人去操作某個東西。 */
const ACTION_REF = /(?:用|按|到|點選|從)[^「」]{0,8}「([^」]{1,30})」/g;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(vue|ts)$/.test(p) && p !== I18N_FILE) out.push(p);
  }
  return out;
}

/** `t` 裡每一個字串值 → 它所在的路徑（可能不只一個）。 */
function pathsByValue(node: unknown, prefix: string, out: Map<string, string[]>): void {
  if (typeof node === 'string') {
    const list = out.get(node) ?? [];
    list.push(prefix);
    out.set(node, list);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) pathsByValue(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

const componentSource = walk(WEB_SRC)
  .map((f) => readFileSync(f, 'utf8'))
  .join('\n');

const byValue = new Map<string, string[]>();
pathsByValue(t, '', byValue);

/** 這個標籤有沒有一個 key 真的被畫在畫面上。 */
function isRendered(label: string): boolean {
  return (byValue.get(label) ?? []).some((path) => componentSource.includes(`t.${path}`));
}

function actionRefs(message: string): string[] {
  return [...message.matchAll(ACTION_REF)].flatMap((m) =>
    (m[1] ?? '').split('→').map((s) => s.trim()),
  );
}

describe('錯誤訊息引用的按鈕', () => {
  it('掃得到東西 —— 一個掃不到引用的檢查永遠會過', () => {
    const all = Object.values(errorMessages).flatMap(actionRefs);
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(componentSource.length).toBeGreaterThan(10_000);
  });

  it('每一個「叫人去按」的標籤，都有一個元件真的把它畫出來', () => {
    const phantom: string[] = [];
    for (const [code, message] of Object.entries(errorMessages)) {
      for (const label of actionRefs(message)) {
        if (!isRendered(label)) phantom.push(`${code} →「${label}」`);
      }
    }
    expect(phantom).toEqual([]);
  });

  /**
   * **注入 2026-09-11 修掉的那一句，連同那個孤兒 key。**
   *
   * 兩個條件要同時成立才算數：訊息叫人按「開啟既有資料夾」，
   * 而 `zh-TW.ts` 裡**真的有**一個值是那個字串的 key。
   * 第一版的判準在這個組合下會放行 —— 這一條確認現在的不會。
   */
  it('判準認得出「字串存在、但沒有任何元件用到」的那一種', () => {
    const orphanPath = 'caseList.openExisting';
    const withOrphan = new Map(byValue);
    withOrphan.set('開啟既有資料夾', [orphanPath]);
    expect(componentSource.includes(`t.${orphanPath}`)).toBe(false);

    const refs = actionRefs('找不到這個專題 —— 用「開啟既有資料夾」重新指到它。');
    expect(refs).toEqual(['開啟既有資料夾']);
    // 那一次誤報：「端點」的「點」不是動詞。
    expect(actionRefs('這個模型在這個端點上連「回一份 JSON」都不保證')).toEqual([]);
    const rendered = refs.every((label) =>
      (withOrphan.get(label) ?? []).some((path) => componentSource.includes(`t.${path}`)),
    );
    expect(rendered).toBe(false);

    // 而一個真的畫在畫面上的標籤要過。
    expect(isRendered(t.reader.openSnapshot)).toBe(true);
  });
});
