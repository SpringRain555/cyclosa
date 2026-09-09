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
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

import {
  TASK_ANGLES,
  TASK_EXTRACT,
  REQUIRED_CONTEXT_TOKENS,
  WORST_TOKENS_PER_CHAR,
  missingFor,
  NO_CAPABILITIES,
} from '../../src/domain/provider/capabilities.js';
import {
  MAX_ENTITIES,
  MAX_NAME_CHARS,
  MAX_REL_CHARS,
  MAX_RELATIONS,
} from '../../src/domain/provider/relations.js';
import { MAX_QUOTE_CHARS, MIN_QUOTE_CHARS } from '../../src/domain/provider/quote.js';
import { EXTRACT_SCHEMA, MAX_TEXT_CHARS } from '../../src/application/expansion-prompts.js';

describe('抽取的 context 門檻要蓋得住實際送出去的正文', () => {
  it('最壞的 tokenizer 之下，正文 ＋ 提示詞 ＋ 輸出仍在門檻內', () => {
    const bodyTokens = MAX_TEXT_CHARS * WORST_TOKENS_PER_CHAR;
    // 系統提示與 schema 大約 600。
    // 輸出的預算是 8,000：**2026-09-09 補上 `maxItems` 之後實測 1,289–1,627**，
    // 取約五倍餘裕。（補之前是 11,474 —— 沒有上界的陣列會一直吐到視窗滿。）
    // **輸出也算在 context 裡** —— 多數執行環境的 context 是「輸入＋輸出」。
    const need = bodyTokens + 600 + 8000;
    expect(TASK_EXTRACT.minContextTokens ?? 0).toBeGreaterThanOrEqual(need);
  });

  it('**抽取的門檻要比歸納角度高** —— 角度吃的是標題清單，抽取吃的是整份正文', () => {
    expect(TASK_EXTRACT.minContextTokens ?? 0).toBeGreaterThan(TASK_ANGLES.minContextTokens ?? 0);
  });

  it('抽取需要 json_schema —— 它是外部文字那三層防護的第二層', () => {
    expect(TASK_EXTRACT.needs).toContain('json_schema');
  });
});

describe('送出去的請求要自己指定 context，不吃 Ollama 的預設', () => {
  it('`REQUIRED_CONTEXT_TOKENS` 蓋得住每一個任務', () => {
    for (const task of [TASK_ANGLES, TASK_EXTRACT]) {
      expect(REQUIRED_CONTEXT_TOKENS).toBeGreaterThanOrEqual(task.minContextTokens ?? 0);
    }
  });

  /**
   * **這一條守的是一個 2026-09-09 量到的落差。**
   *
   * `/api/tags` 對 `nemotron-cascade-2:30b` 回 `context_length: 262144`，
   * 而 `ollama ps` 顯示實際載入的是 **32768** —— Ollama 用的是它自己的預設，
   * 不是模型的上限。閘門看的是前一個，執行時用的是後一個。
   *
   * **而 `gemma4:31b` 與 `translategemma:12b` 根本沒有那一欄**：宣告是 0、
   * 閘門當「不知道」放行。對它們來說這條請求參數是唯一擋得住的東西。
   *
   * 所以請求裡一定要帶 `num_ctx`。這條測試釘的是「那個常數被送出去了」。
   */
  it('`chat-ollama` 的請求裡帶了 `num_ctx`', async () => {
    const source = await readFile(
      new URL('../../src/infrastructure/providers/chat-ollama.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('num_ctx: REQUIRED_CONTEXT_TOKENS');
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
    expect(match.context).toEqual([24_000, 8000]);
  });

  it('context 宣告是 0 時放行 —— **不知道與很小是兩件事**', () => {
    expect(missingFor(TASK_EXTRACT, { ...capable, context_tokens: 0 }).kind).toBe('ok');
  });

  it('夠大的就過', () => {
    expect(missingFor(TASK_EXTRACT, { ...capable, context_tokens: 32_768 }).kind).toBe('ok');
  });
});

/**
 * **送出去的 schema 要帶著正規化那一層的上限。**
 *
 * 這一組守的是 2026-09-09 量到的一個具體落差。`EXTRACT_SCHEMA` 的兩個陣列
 * 原本**沒有 `maxItems`**，而受限解碼只保證形狀 ——
 * **一個沒有上界的陣列在任何長度都是合法的。**
 *
 * 於是 `gemma4:31b` 吐出 43 個實體、29 條關係（`normalizeExtraction` 留 20／20），
 * 視窗用掉 87%；而 `translategemma:12b` 有一次吐了 55,467 個字元，
 * 形狀一路合法到視窗用完為止，回來的是一份解不開的東西。
 *
 * 機械上的原因很小：`MAX_ANGLES` 是 `export` 的，所以 `ANGLES_SCHEMA`
 * 一直帶著 `maxItems`、角度那一步從來沒失控過；
 * 而 `MAX_ENTITIES` 那四個當時是私有的 `const`，**schema 那一層拿不到**。
 *
 * 所以這裡釘的不是「有沒有寫上界」，是**兩邊的上界是同一個數字** ——
 * 只改一邊的話，多出來的那些會回到「生完才丟」的老路上。
 */
describe('抽取 schema 的上界要等於正規化實際執行的上界', () => {
  const props = EXTRACT_SCHEMA.properties;

  it('陣列長度：schema 的 maxItems ＝ domain 的丟棄門檻', () => {
    expect(props.entities.maxItems).toBe(MAX_ENTITIES);
    expect(props.relations.maxItems).toBe(MAX_RELATIONS);
  });

  it('名稱與關係詞的長度上限兩邊一致', () => {
    expect(props.entities.items.properties.name.maxLength).toBe(MAX_NAME_CHARS);
    expect(props.relations.items.properties.subject.maxLength).toBe(MAX_NAME_CHARS);
    expect(props.relations.items.properties.object.maxLength).toBe(MAX_NAME_CHARS);
    expect(props.relations.items.properties.rel.maxLength).toBe(MAX_REL_CHARS);
  });

  it('**引文的上下界就是 `locateQuote` 的判準** —— 生完才發現用不了是白花的', () => {
    const quote = props.relations.items.properties.quote;
    expect(quote.minLength).toBe(MIN_QUOTE_CHARS);
    expect(quote.maxLength).toBe(MAX_QUOTE_CHARS);
  });
});
