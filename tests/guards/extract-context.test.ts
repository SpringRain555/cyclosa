/**
 * 守門：**送進模型的正文上限，不能超過那個任務宣告的 context 需求。**
 *
 * 這兩個數字住在不同的層，而且方向相反：
 *
 * | 誰 | 在哪 | 是什麼 |
 * |---|---|---|
 * | `MAX_TEXT_CHARS` | `application/expansion-prompts.ts` | 我們**送出去**多少字 |
 * | `TASK_EXTRACT.minContextTokens` | `domain/provider/capabilities.ts` | 我們**要求對方**多大 |
 *
 * 分開是對的（domain 不該知道提示詞長什麼樣），但分開之後**改一個很容易忘了另一個**，
 * 而失效的方式是靜默的：送出去的正文超過對方的 context，
 * 對方就把前面截掉，然後照常回一份 JSON —— **抽出來的關聯照樣帶引文、
 * 照樣進待查證，畫面上看不出任何異常。**
 *
 * 中間那個換算（字元 → token）也不是猜的：
 * 2026-09-09 拿同一段 12,000 字的中文實測三個 tokenizer 家族，
 * 最壞的是 OLMo 的 1.20 token／字元（最好的 Gemma 是 0.67，**差 1.8 倍**）。
 * 那個比例存在 `WORST_TOKENS_PER_CHAR`。
 */
import { describe, expect, it } from 'vitest';

import {
  TASK_ANGLES,
  TASK_EXTRACT,
  WORST_TOKENS_PER_CHAR,
  missingFor,
  NO_CAPABILITIES,
} from '../../src/domain/provider/capabilities.js';
import { MAX_TEXT_CHARS } from '../../src/application/expansion-prompts.js';

describe('抽取的 context 門檻要蓋得住實際送出去的正文', () => {
  it('最壞的 tokenizer 之下，正文 ＋ 提示詞 ＋ 輸出仍在門檻內', () => {
    const bodyTokens = MAX_TEXT_CHARS * WORST_TOKENS_PER_CHAR;
    // 系統提示與 schema 大約 600，抽出來的實體與引文大約 2000。
    // **輸出也算在 context 裡** —— 多數執行環境的 context 是「輸入＋輸出」。
    const need = bodyTokens + 600 + 2000;
    expect(TASK_EXTRACT.minContextTokens ?? 0).toBeGreaterThanOrEqual(need);
  });

  it('**抽取的門檻要比歸納角度高** —— 角度吃的是標題清單，抽取吃的是整份正文', () => {
    expect(TASK_EXTRACT.minContextTokens ?? 0).toBeGreaterThan(TASK_ANGLES.minContextTokens ?? 0);
  });

  it('抽取需要 json_schema —— 它是外部文字那三層防護的第二層', () => {
    expect(TASK_EXTRACT.needs).toContain('json_schema');
  });
});

describe('context 不夠會被擋下來，而且說得出差多少', () => {
  const capable = { ...NO_CAPABILITIES, json_schema: true };

  it('剛好 8000（過得了角度那一關）的模型，抽取這一關過不了', () => {
    const have = { ...capable, context_tokens: 8000 };
    expect(missingFor(TASK_ANGLES, have).kind).toBe('ok');

    const match = missingFor(TASK_EXTRACT, have);
    expect(match.kind).toBe('missing');
    if (match.kind !== 'missing') return;
    // **旗標是空的，缺的是 context** —— 這正是原本會顯示成「缺少：（空白）」的那種情況
    expect(match.flags).toEqual([]);
    expect(match.context).toEqual([18_000, 8000]);
  });

  it('context 宣告是 0 時放行 —— **不知道與很小是兩件事**', () => {
    expect(missingFor(TASK_EXTRACT, { ...capable, context_tokens: 0 }).kind).toBe('ok');
  });

  it('夠大的就過', () => {
    expect(missingFor(TASK_EXTRACT, { ...capable, context_tokens: 32_768 }).kind).toBe('ok');
  });
});
