/**
 * 守門：**任務名與連線種類，在 server 與 web 要是同一組。**
 *
 * ## 為什麼會有好幾份
 *
 * | 在哪 | 為什麼在那裡 |
 * |---|---|
 * | `domain/provider/capabilities.ts` | 唯一的定義（`CHAT_TASKS`、`MODEL_TASKS`）|
 * | `infrastructure/providers/config.ts` | 連線種類的唯一定義（`CONNECTION_KINDS`）|
 * | `web/src/api.ts` | `web/` 與 server 是兩份建置，型別不能跨過去 |
 * | `web/src/i18n/zh-TW.ts` | 每個任務要有名字、說明；每種連線要有名字、說明 |
 * | `SettingsView.vue` | 每個任務的建議模型、每個任務可以走哪些連線 |
 *
 * **只有前兩份是定義，其餘是抄的。** 這個 repo 今天已經因為同一種形狀
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
import { CONNECTION_KINDS, viaOptionsOf } from '../../src/infrastructure/providers/config.js';

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
  return [...block.matchAll(/^\s{6}'?([a-z_-]+)'?:/gm)].map((m) => m[1] as string).sort();
}

const expected = [...CHAT_TASKS].sort();
const allTasks = MODEL_TASKS.map((t) => t.task).sort();

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

  it('設定頁的建議模型涵蓋全部 chat 任務', () => {
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
 * 設定頁上那張表是跨角色的，於是任務名從 `chat` 底下的兩個擴成四個（`MODEL_TASKS`）。
 * 而擴出來的那兩個 —— `find-sources` 與 `embed` —— 走的是**跟 chat 完全不同的連線**，
 * 所以「i18n 有而 server 沒有」這種漂法在它們身上更容易發生。
 */
describe('四個任務的名字在 server 與 web 是同一組', () => {
  it('`CHAT_TASKS` 就是 `MODEL_TASKS` 裡角色是 chat 的那些', () => {
    // 兩份定義**必須推導得出對方** —— 否則加一個 chat 任務時會只加到一邊，
    // 而症狀是「設定檔裡那個任務永遠讀不出來」。
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

  it('i18n 的「為什麼建議它」涵蓋每一個有建議值的任務', () => {
    // 有建議值的是 chat 那兩個加 embed；找來源沒有（沒量過在 CLI 那邊換模型的效果）。
    const withRecommendation = [...CHAT_TASKS, 'embed'].sort();
    expect(keysOf(i18n, 'taskRecommendWhy')).toEqual(withRecommendation);
  });

  it('設定頁那張表的建議值涵蓋全部四個，而且表的列就是 MODEL_TASKS 的順序', () => {
    const start = view.indexOf('const RECOMMENDED_TASK_ALL: Record<ModelTask, string> = {');
    expect(start).toBeGreaterThan(-1);
    const block = view.slice(start, view.indexOf('};', start));
    // `...RECOMMENDED_TASK` 展開了 chat 那兩個，所以逐字寫出來的只有另外兩個。
    expect(block).toContain('...RECOMMENDED_TASK');
    for (const task of allTasks) {
      if ((CHAT_TASKS as readonly string[]).includes(task)) continue;
      expect(block, task).toMatch(new RegExp(`'?${task}'?:`));
    }
    // 表的列順序：畫面自己排（`TASK_ORDER`），而它要跟 server 那份定義一樣 ——
    // 兩邊順序不同的話，使用者在設定頁看到的順序跟作業紀錄裡的不一樣。
    const order = view.match(/const TASK_ORDER: readonly ModelTask\[\] = \[([^\]]+)\]/)?.[1] ?? '';
    const tasksInView = [...order.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
    expect(tasksInView).toEqual(MODEL_TASKS.map((t) => t.task));
  });
});

/**
 * v0.24.0：**連線種類也是一組跨建置的字串**（ADR-0032）。
 * 每個任務可以走哪些連線是 server 由角色推出來的（`viaOptionsOf`），
 * 而設定頁自己也寫了一份同樣的規則 —— 兩邊不一致的症狀是「畫面讓你選了一條
 * server 存檔時會退回去的連線」，使用者看到的是「我選的不見了」。
 */
describe('連線種類在 server 與 web 是同一組', () => {
  it('`web/src/api.ts` 的 ConnectionKind 聯集一字不差', () => {
    const union = CONNECTION_KINDS.map((k) => `'${k}'`).join(' | ');
    expect(api).toContain(`export type ConnectionKind = ${union};`);
  });

  it('i18n 每種連線都有名字與說明', () => {
    for (const block of ['connectionNames', 'connectionWhat']) {
      expect(keysOf(i18n, block), block).toEqual([...CONNECTION_KINDS].sort());
    }
  });

  it('設定頁「每個任務可以走哪些連線」跟 server 的規則一樣', () => {
    const start = view.indexOf('function viaOptions(task: ModelTask): readonly ConnectionKind[] {');
    expect(start).toBeGreaterThan(-1);
    const body = view.slice(start, view.indexOf('\n}', start));
    for (const { task } of MODEL_TASKS) {
      const expectedVia = viaOptionsOf(task);
      // 只有一種的任務在畫面上是 `if (task === '…') return ['…']`；其餘落到最後那一行。
      if (expectedVia.length === 1) {
        expect(body, task).toContain(`if (task === '${task}') return ['${expectedVia[0]}'];`);
      } else {
        expect(body).toContain(`return [${expectedVia.map((k) => `'${k}'`).join(', ')}];`);
      }
    }
  });
});
