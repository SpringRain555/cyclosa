/**
 * 守門：**設定頁裡的建議模型，要跟 server 那一份是同一個字串。**
 *
 * ## 為什麼會有兩份
 *
 * `web/` 與 server 是兩個獨立的建置（`tsconfig.web.json` 不含 `src/`），
 * 所以 `SettingsView.vue` 只能自己抄一份模型名字。**那是結構性的，不是懶。**
 *
 * 而抄的那一份會漂。這個 repo 今天已經因為同一種形狀修過三次：
 * 「哪些專案有 agent 檔」、卡片的 `data_root`、`docs/index.md` 的現況欄。
 *
 * ## 漂掉會發生什麼
 *
 * 建議值不是裝飾：**它是使用者唯一看得到的「該選哪個」**。
 * 量測換了模型而畫面沒換，使用者會照著一個過期的建議去設定，
 * 而畫面上那句「為什麼建議它」講的是**新模型的數字**。
 * 那比沒有建議更糟 —— 它看起來已經被驗證過了。
 */
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import { CHAT_TASKS } from '../../src/domain/provider/index.js';
import {
  RECOMMENDED_CHAT_MODEL,
  RECOMMENDED_EMBED_MODEL,
  RECOMMENDED_TASK_MODELS,
} from '../../src/infrastructure/providers/config.js';

const view = await readFile(
  new URL('../../web/src/views/SettingsView.vue', import.meta.url),
  'utf8',
);

describe('設定頁的建議模型與 server 的常數一致', () => {
  it('chat', () => {
    expect(view).toContain(`const RECOMMENDED_CHAT = '${RECOMMENDED_CHAT_MODEL}';`);
  });

  it('embed', () => {
    expect(view).toContain(`const RECOMMENDED_EMBED = '${RECOMMENDED_EMBED_MODEL}';`);
  });

  /**
   * **建議的模型要真的出現在那個角色的欄位旁邊。**
   *
   * 常數對得上、按鈕忘了接，是另一種漂 —— 而它不會有任何測試變紅。
   */
  it('兩個建議都有一顆按得下去的按鈕', () => {
    expect(view).toContain('@click="model = RECOMMENDED_CHAT"');
    expect(view).toContain('@click="embedModel = RECOMMENDED_EMBED"');
  });

  /**
   * **逐任務的那幾個也是抄的，所以也要釘。**
   *
   * 這一組比上面兩個更容易漂：它們不是「一個字串」而是「一張表」，
   * 而一張表可以**只有一格對**（另一格是舊模型），
   * 那種狀態下畫面看起來完全正常。
   */
  it('逐任務的建議值與 server 的那張表逐格一致', () => {
    for (const task of CHAT_TASKS) {
      expect(view, task).toContain(`  ${task}: `);
    }
    // 抽取那一格在設定頁裡是引用常數（`extract: RECOMMENDED_CHAT`），
    // 所以只有跟預設不同的那些會是字面值 —— 逐格比對要看實際的字串。
    for (const task of CHAT_TASKS) {
      const model = RECOMMENDED_TASK_MODELS[task];
      const literal = `${task}: '${model}',`;
      const viaConst = model === RECOMMENDED_CHAT_MODEL ? `${task}: RECOMMENDED_CHAT,` : null;
      expect(
        view.includes(literal) || (viaConst !== null && view.includes(viaConst)),
        `${task} 的建議值在設定頁裡不是 ${model}`,
      ).toBe(true);
    }
  });

  it('每個任務的建議都有一顆按得下去的按鈕', () => {
    // 一顆按鈕跑全部任務（`RECOMMENDED_TASK_ALL[row.task]`），所以釘的是那個索引 ——
    // 它在的話，新增一個任務不會漏掉按鈕。
    //
    // **2026-09-10 換了形狀**：那張表擴成跨角色的四列之後，寫回哪一個 ref
    // 依角色而異（chat 寫 `taskModels`、embed 寫 `embedModel`、
    // agent 寫 `agentModel`），所以繫結從直接指派改成一支轉換函式。
    expect(view).toContain('@click="setModelOf(row.task, RECOMMENDED_TASK_ALL[row.task])"');
  });

  it('沒有依據的那一格是空字串，不是一個編出來的模型名', () => {
    // `find-sources` 跑在 agent 上，而**我們沒有量過在那一邊換模型的效果**
    // —— `docs/research/` 那幾輪量的是本機 chat 模型。
    // 空字串讓那一列不出現建議按鈕；填一個名字會讓它看起來像量過的。
    const start = view.indexOf('const RECOMMENDED_TASK_ALL');
    expect(start).toBeGreaterThan(-1);
    const block = view.slice(start, view.indexOf('};', start));
    expect(block).toMatch(/'find-sources':\s*''/);
  });
});
