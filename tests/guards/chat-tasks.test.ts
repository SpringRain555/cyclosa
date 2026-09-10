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

import {
  CHAT_TASKS,
  CHAT_TASK_REQUIREMENTS,
  MODEL_TASKS,
} from '../../src/domain/provider/capabilities.js';

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
  // 鍵可能帶引號（`'find-sources':`），因為它有連字號。
  return [...block.matchAll(/^\s{6}'?([a-z-]+)'?:/gm)].map((m) => m[1] as string).sort();
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

/**
 * 2026-09-10：**同一種形狀又多了一組字串，所以守它的測試也要跟著多一組。**
 *
 * 設定頁上那張「各任務模型」的表是跨角色的，於是任務名從 `chat` 底下的兩個
 * 擴成四個（`MODEL_TASKS`）。而擴出來的那兩個 —— `find-sources` 與 `embed`
 * —— 走的是**跟 chat 完全不同的欄位**（前者是 CLI 的旗標，後者是角色自己的模型），
 * 所以「i18n 有而 server 沒有」這種漂法在它們身上更容易發生。
 */
const allTasks = MODEL_TASKS.map((t) => t.task).sort();

describe('四個任務的名字在 server 與 web 是同一組', () => {
  it('`CHAT_TASKS` 就是 `MODEL_TASKS` 裡角色是 chat 的那些', () => {
    // 兩份定義**必須推導得出對方** —— 否則加一個 chat 任務時會只加到一邊，
    // 而症狀是「設定檔裡那個覆寫永遠讀不出來」。
    const fromRegistry = MODEL_TASKS.filter((t) => t.role === 'chat')
      .map((t) => t.task)
      .sort();
    expect(fromRegistry).toEqual([...CHAT_TASKS].sort());
  });

  it('每個任務都在表裡有一份需求宣告', () => {
    expect(allTasks.length).toBe(new Set(allTasks).size);
    for (const entry of MODEL_TASKS) {
      // **`embed` 的需求是空的，而那不是漏寫**（見 `TASK_EMBED` 的註解）——
      // 四個布林旗標描述的是對話模型會不會做某件事，而嵌入端點一件都不做。
      // 所以這裡不能一律要求非空；能要求的是**只有它可以是空的**。
      if (entry.task === 'embed') expect(entry.requirement.needs).toEqual([]);
      else expect(entry.requirement.needs.length, entry.task).toBeGreaterThan(0);
    }
  });

  it('`web/src/api.ts` 的 ModelTask 聯集涵蓋全部四個', () => {
    const line = api.match(/export type ModelTask = [^;]+;/)?.[0] ?? '';
    expect(line).not.toBe('');
    for (const task of allTasks) {
      // `ChatTask` 是被引用進去的，所以那兩個不會逐字出現在這一行。
      if ((CHAT_TASKS as readonly string[]).includes(task)) continue;
      expect(line, task).toContain(`'${task}'`);
    }
    expect(line).toContain('ChatTask');
  });

  it('i18n 的任務名與說明各自涵蓋全部四個', () => {
    for (const block of ['taskNames', 'taskWhat']) {
      expect(keysOf(i18n, block), block).toEqual(allTasks);
    }
  });

  it('設定頁那張表的建議值涵蓋全部四個', () => {
    const start = view.indexOf('const RECOMMENDED_TASK_ALL: Record<ModelTask, string> = {');
    expect(start).toBeGreaterThan(-1);
    const block = view.slice(start, view.indexOf('};', start));
    // `...RECOMMENDED_TASK` 展開了 chat 那兩個，所以逐字寫出來的只有另外兩個。
    expect(block).toContain('...RECOMMENDED_TASK');
    for (const task of allTasks) {
      if ((CHAT_TASKS as readonly string[]).includes(task)) continue;
      expect(block, task).toMatch(new RegExp(`'?${task}'?:`));
    }
  });
});
