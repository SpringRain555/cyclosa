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
  TASK_DIGEST,
  TASK_EXTRACT,
  TASK_PLAN,
  REQUIRED_CONTEXT_TOKENS,
  WORST_TOKENS_PER_CHAR,
  missingFor,
  NO_CAPABILITIES,
} from '../../src/domain/provider/capabilities.js';
import {
  DIGEST_SOURCE_TITLE_CHARS,
  DIGEST_TEXT_CHARS,
  DIGEST_TOPIC_CHARS,
  DIGEST_URL_CHARS,
  MAX_DIGEST_SUMMARY_CHARS,
  MAX_DIGEST_TITLE_CHARS,
  MAX_DIGEST_WHY_CHARS,
} from '../../src/domain/provider/digest.js';
import {
  MAX_DIRECTIONS,
  MAX_DIRECTION_TITLE_CHARS,
  MAX_RELATION_CHARS,
} from '../../src/domain/provider/plan.js';
import {
  PLAN_SCHEMA,
  CANDIDATES_SCHEMA,
  DIGEST_SCHEMA,
  DIGEST_SYSTEM,
  digestUser,
  MAX_PLAN_PROMPT_CHARS,
} from '../../src/application/research-prompts.js';
import {
  MAX_ENTITIES,
  MAX_NAME_CHARS,
  MAX_REL_CHARS,
  MAX_RELATIONS,
} from '../../src/domain/provider/relations.js';
import { MAX_QUOTE_CHARS, MIN_QUOTE_CHARS } from '../../src/domain/provider/quote.js';
import {
  MAX_CANDIDATE_URL_CHARS,
  MAX_CANDIDATES_PER_DIRECTION,
  MAX_CANDIDATE_WHY_CHARS,
} from '../../src/domain/provider/candidates.js';
import { EXTRACT_SCHEMA, MAX_TEXT_CHARS } from '../../src/application/extraction-prompts.js';

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

  it('抽取的門檻要比規劃高，抽取吃的是整份正文', () => {
    expect(TASK_EXTRACT.minContextTokens ?? 0).toBeGreaterThan(TASK_PLAN.minContextTokens ?? 0);
  });

  it('抽取需要 json_schema —— 它是外部文字那三層防護的第二層', () => {
    expect(TASK_EXTRACT.needs).toContain('json_schema');
  });
});

/**
 * **規劃對話與初讀是同一種關係**（Stage 19、21）：送出去的字數在 application，要求對方的 context 在 domain。
 *
 * 規劃那一條 2026-09-30 才補上 —— `TASK_PLAN` 與 `MAX_PLAN_PROMPT_CHARS` 的註解都寫「這個守門釘著」，
 * 而這份檔案裡從來沒有它。**一句「有守門」的註解，跟一條不存在的守門長得一模一樣。**
 */
describe('規劃對話與初讀的 context 門檻，也要蓋得住實際送出去的提示詞', () => {
  it('規劃：攤平的整段對話 ＋ 輸出', () => {
    // 輸出那一側 8,000：12 條方向各帶標題、要找什麼、預期來源、關鍵詞 ＋ reply 等，照 PLAN_SCHEMA 算滿約 6,000 字元。
    const need = MAX_PLAN_PROMPT_CHARS * WORST_TOKENS_PER_CHAR + 8000;
    expect(TASK_PLAN.minContextTokens ?? 0).toBeGreaterThanOrEqual(need);
  });

  it('初讀：正文開頭 ＋ 其餘每一行的上限 ＋ 輸出', () => {
    // 「研究主題：」「<資料>」這些固定的字，加上每條方向前面的「12. 」，抓 200。
    const labels = 200;
    const promptChars =
      DIGEST_SYSTEM.length +
      DIGEST_TEXT_CHARS +
      DIGEST_TOPIC_CHARS +
      MAX_RELATION_CHARS +
      MAX_DIRECTIONS * MAX_DIRECTION_TITLE_CHARS +
      DIGEST_SOURCE_TITLE_CHARS +
      DIGEST_URL_CHARS +
      labels;
    // 輸出照 schema 的上界算滿，再留一倍給 JSON 的鍵與引號 —— 取 2,000 跟它比大的那一個。
    const outputChars = MAX_DIGEST_WHY_CHARS + MAX_DIGEST_TITLE_CHARS + MAX_DIGEST_SUMMARY_CHARS;
    const output = Math.max(2000, outputChars * WORST_TOKENS_PER_CHAR * 2);
    const need = promptChars * WORST_TOKENS_PER_CHAR + output;
    expect(TASK_DIGEST.minContextTokens ?? 0).toBeGreaterThanOrEqual(need);
  });

  it('初讀的提示詞真的切在那些上限 —— 每一格都塞超長的也一樣', () => {
    const long = '字'.repeat(20_000);
    const prompt = digestUser({
      topic: long,
      relation: long,
      directions: Array.from({ length: 30 }, () => long),
      title: long,
      url: long,
      excerpt: long,
    });
    const ceiling =
      DIGEST_TEXT_CHARS +
      DIGEST_TOPIC_CHARS +
      MAX_RELATION_CHARS +
      MAX_DIRECTIONS * (MAX_DIRECTION_TITLE_CHARS + 6) +
      DIGEST_SOURCE_TITLE_CHARS +
      DIGEST_URL_CHARS +
      200;
    expect(prompt.length).toBeLessThanOrEqual(ceiling);
  });

  it('初讀需要 json_schema —— 它跟抽取一樣把別人網站上的文字放進提示詞', () => {
    expect(TASK_DIGEST.needs).toContain('json_schema');
  });

  it('初讀 schema 的長度上限等於正規化切的長度', () => {
    const p = DIGEST_SCHEMA.properties;
    expect(p.why.maxLength).toBe(MAX_DIGEST_WHY_CHARS);
    expect(p.title_zh.maxLength).toBe(MAX_DIGEST_TITLE_CHARS);
    expect(p.summary_zh.maxLength).toBe(MAX_DIGEST_SUMMARY_CHARS);
  });
});

describe('送出去的請求要自己指定 context，不吃 Ollama 的預設', () => {
  it('`REQUIRED_CONTEXT_TOKENS` 蓋得住每一個任務', () => {
    for (const task of [TASK_EXTRACT, TASK_PLAN, TASK_DIGEST]) {
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

  /**
   * **請求裡要明確關掉思考。**
   *
   * 跟 `num_ctx` 是同一類：不帶就是吃對方的預設，而預設會變、
   * 而且**跟宣告不一致** —— `granite4.2:8b` 在 `/api/tags` 的
   * capabilities 只有 `completion`，實測卻在思考（同一份正文
   * 22,545 個輸出 token／157 秒，關掉之後 3,256／27.7 秒）。
   *
   * 這一條釘的是「那一行被送出去了」。拿掉它不會有任何測試變紅，
   * 而使用者會拿到一個在 180 秒裡交不出東西的抽取。
   */
  it('`chat-ollama` 的請求裡明確關掉思考', async () => {
    const source = await readFile(
      new URL('../../src/infrastructure/providers/chat-ollama.ts', import.meta.url),
      'utf8',
    );
    expect(source).toContain('think: false');
  });
});

describe('context 不夠會被擋下來，而且說得出差多少', () => {
  const capable = { ...NO_CAPABILITIES, json_schema: true };

  it('過得了規劃那一關的模型，抽取這一關仍可能過不了', () => {
    const have = { ...capable, context_tokens: 18000 };
    expect(missingFor(TASK_PLAN, have).kind).toBe('ok');

    const match = missingFor(TASK_EXTRACT, have);
    expect(match.kind).toBe('missing');
    if (match.kind !== 'missing') return;
    // **旗標是空的，缺的是 context** —— 這正是原本會顯示成「缺少：（空白）」的那種情況
    expect(match.flags).toEqual([]);
    expect(match.context).toEqual([24_000, 18000]);
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

/**
 * **另外兩份 schema 也要，而它們原本只做對了一半。**
 *
 * 找到抽取那個缺口之後，照 `lessons.md` 那條「回去看有沒有一個已經做對的兄弟」
 * 反過來查了一次：`ANGLES_SCHEMA` 與 `SOURCES_SCHEMA` **有 `maxItems`
 * 但沒有 `maxLength`**，而 `normalizeAngles` 對超過 160 字的 `question`
 * 是**整條角度丟掉**（`text()` 回空字串，迴圈裡 `continue`）。
 *
 * 影響比抽取那一個小得多 —— 角度的輸出本來就短，撐不爆視窗。
 * 但使用者看得到：模型提了六條、畫面上只有五條，**而沒有任何地方說少的那條去哪了**。
 */
describe('研究方向與來源的 schema 上界，也要等於正規化的門檻', () => {
  it('方向：條數、標題長度', () => {
    const directions = PLAN_SCHEMA.properties.directions;
    expect(directions.maxItems).toBe(MAX_DIRECTIONS);
    expect(directions.items.properties.title.maxLength).toBe(MAX_DIRECTION_TITLE_CHARS);
  });

  it('來源：候選數、URL 長度、理由長度', () => {
    const candidates = CANDIDATES_SCHEMA.properties.candidates;
    expect(candidates.maxItems).toBe(MAX_CANDIDATES_PER_DIRECTION);
    expect(candidates.items.properties.url.maxLength).toBe(MAX_CANDIDATE_URL_CHARS);
    expect(candidates.items.properties.why.maxLength).toBe(MAX_CANDIDATE_WHY_CHARS);
  });
});
