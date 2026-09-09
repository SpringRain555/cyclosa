/**
 * 守門：**`chat` 底下那組任務名，在四個地方要是同一組。**
 *
 * ## 為什麼會有四份
 *
 * | 在哪 | 為什麼在那裡 |
 * |---|---|
 * | `domain/provider/capabilities.ts` | 唯一的定義（`CHAT_TASKS`）|
 * | `web/src/api.ts` | `web/` 與 server 是兩份建置，型別不能跨過去 |
 * | `web/src/i18n/zh-TW.ts` | 每個任務要有名字、說明與「為什麼建議這個」 |
 * | `SettingsView.vue` | 每個任務的建議模型 |
 *
 * **只有第一份是定義，其餘三份是抄的。** 這個 repo 今天已經因為同一種形狀
 * 修過四次（哪些專案有 agent 檔、卡片的 `data_root`、`docs/index.md` 的現況欄、
 * 設定頁的建議模型），所以新增一組跨建置的字串就要同時新增守它的測試。
 *
 * ## 漂掉會發生什麼
 *
 * server 加了一個任務而 i18n 沒加 → 設定頁上那一格的標題是 `undefined`。
 * i18n 有而 server 沒有 → 一個永遠不會出現的欄位。
 * **兩種都不會有任何測試變紅**，而第一種使用者看得到。
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { CHAT_TASKS, CHAT_TASK_REQUIREMENTS } from '../../src/domain/provider/capabilities.js';

const web = new URL('../../web/src/', import.meta.url);
const api = await readFile(new URL('api.ts', web), 'utf8');
const i18n = await readFile(new URL('i18n/zh-TW.ts', web), 'utf8');
const view = await readFile(new URL('views/SettingsView.vue', web), 'utf8');

/** `key: '…'` 這種行的鍵。**只掃一個區塊**，不是整份檔案 */
function keysOf(source: string, blockName: string): string[] {
  const start = source.indexOf(`${blockName}: {`);
  if (start < 0) return [];
  const end = source.indexOf('\n    },', start);
  const block = source.slice(start, end < 0 ? undefined : end);
  return [...block.matchAll(/^\s{6}([a-z]+):/gm)].map((m) => m[1] as string).sort();
}

const expected = [...CHAT_TASKS].sort();

describe('chat 的任務名在 server 與 web 是同一組', () => {
  it('每個任務都有一份需求宣告', () => {
    expect(Object.keys(CHAT_TASK_REQUIREMENTS).sort()).toEqual(expected);
    // **需求不能是空的** —— 一個什麼都不要求的任務等於沒有閘門。
    for (const task of CHAT_TASKS) {
      expect(CHAT_TASK_REQUIREMENTS[task].needs.length).toBeGreaterThan(0);
    }
  });

  it('`web/src/api.ts` 的 ChatTask 聯集一字不差', () => {
    const union = expected.map((t) => `'${t}'`).join(' | ');
    expect(api).toContain(`export type ChatTask = ${union};`);
  });

  it('i18n 三個區塊各自涵蓋全部任務', () => {
    for (const block of ['chatTaskNames', 'chatTaskWhat', 'chatTaskRecommendWhy']) {
      expect(keysOf(i18n, block), block).toEqual(expected);
    }
  });

  it('設定頁的建議模型涵蓋全部任務', () => {
    const start = view.indexOf('const RECOMMENDED_TASK: Record<ChatTask, string> = {');
    expect(start).toBeGreaterThan(-1);
    const block = view.slice(start, view.indexOf('};', start));
    const keys = [...block.matchAll(/^\s{2}([a-z]+):/gm)].map((m) => m[1] as string).sort();
    expect(keys).toEqual(expected);
  });
});
