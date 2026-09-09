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

import {
  RECOMMENDED_CHAT_MODEL,
  RECOMMENDED_EMBED_MODEL,
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
});
