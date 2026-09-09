/**
 * 分塊（Stage 12 後半）。
 *
 * **這一支的兩個責任是分開的，而測試也分開**：
 *
 * 1. **切出來的內容**要跟量測嵌入模型時用的那一支一樣 ——
 *    不一樣的話，`embedding-choice.md` 那個 MRR 0.940 對出貨的東西不成立。
 * 2. **偏移量**要真的指得回原文 —— 那是「命中要指得回原文」的一半。
 *
 * 第 2 點是研究工具那一版沒有的（它只回字串），所以它在這裡第一次被測。
 */
import { describe, expect, it } from 'vitest';

import {
  CHUNK_CJK,
  CHUNK_LATIN,
  MAX_CHUNKS_PER_ITEM,
  chunkRuleFor,
  chunkText,
} from '../../src/domain/search/chunk.js';

/** 一段夠長的中文，長度剛好超過 `CHUNK_CJK.min`。 */
const ZH_LINE =
  '這一行刻意寫得夠長，因為切段的門檻是一百二十個字元，而低於門檻的那些會被當成標題或殘留丟掉。' +
  '所以這裡再補幾句話，讓它穩穩地超過那個數字，測試量到的才是切段規則本身而不是門檻。' +
  '再多寫一句把長度推過門檻，順便讓這一行讀起來仍然像一段真的文字而不是一串填充。';

describe('切段的規則', () => {
  it('**看文字不看語言碼** —— 中文的目標長度比較短', () => {
    expect(chunkRuleFor(ZH_LINE)).toEqual(CHUNK_CJK);
    expect(chunkRuleFor('The quick brown fox jumps over the lazy dog.')).toEqual(CHUNK_LATIN);
    // **同樣一段話中文用的字數大約是英文的一半** —— 用同一個預算切，
    // 中文段落的資訊量只有英文的一半。
    expect(CHUNK_CJK.target).toBeLessThan(CHUNK_LATIN.target);
  });

  it('太短的行被丟掉，而且它同時是一個段落界線', () => {
    // 中間那一行是「章節標題」的樣子 —— Readability 的輸出裡它就是一行短字。
    const text = `${ZH_LINE}\n第二章\n${ZH_LINE}`;
    const parts = chunkText(text);
    // 界線讓它變成兩段；短行本身不成段。
    expect(parts).toHaveLength(2);
    for (const p of parts) expect(p.text).not.toContain('第二章');
  });

  /**
   * **保底：整份文件切不出一段的話，整份當成一段。**
   *
   * 2026-09-10 用真的模型跑一次才發現的：一份 97 個字的資料
   * 完全沒有向量，而畫面上看不出來（匯入成功、全文查得到、
   * 只有語意找不到），**回填則永遠回報「還有 1 份沒算」**。
   */
  it('短到不成段 → 整份當成一段，而不是零段', () => {
    const parts = chunkText('太短了');
    expect(parts).toHaveLength(1);
    expect(parts[0]?.text).toBe('太短了');
  });

  it('真的空的才是零段', () => {
    expect(chunkText('')).toHaveLength(0);
    expect(chunkText('     ')).toHaveLength(0);
  });

  /**
   * **這一條是那個缺陷的回歸測試。**
   *
   * 97 個字的中文短於 `detectLanguage` 的 `MIN_SAMPLE_CHARS`（100），
   * 所以它的 `lang` 是 `und` —— 而第一版拿 `und` 去查 `isCjkLanguage`
   * 得到 false，套上拉丁那組（min 320），97 < 320，整份丟掉。
   *
   * 現在切段參數看的是文字本身，所以語言判不出來不影響它。
   */
  it('語言判不出來的中文短文，仍然走 CJK 那組', () => {
    const short = '植物利用葉綠體把光能轉換成化學能，同時把二氧化碳與水合成醣類並釋出氧氣。'.repeat(
      4,
    );
    expect(short.length).toBeGreaterThan(CHUNK_CJK.min);
    expect(short.length).toBeLessThan(CHUNK_LATIN.min);
    expect(chunkRuleFor(short)).toEqual(CHUNK_CJK);
    expect(chunkText(short)).toHaveLength(1);
  });
});

describe('偏移量指得回原文', () => {
  it('每一段的 `[start, end)` 都落在原文裡，而且首尾對得上', () => {
    const text = `標題\n${ZH_LINE}\n分隔\n${ZH_LINE}`;
    const parts = chunkText(text);
    expect(parts.length).toBeGreaterThan(0);
    for (const part of parts) {
      expect(part.start).toBeGreaterThanOrEqual(0);
      expect(part.end).toBeLessThanOrEqual(text.length);
      expect(part.end).toBeGreaterThan(part.start);
      const slice = text.slice(part.start, part.end);
      // **`text` 是行與行接起來的，所以它不一定是子字串** ——
      // 但兩端一定對得上，而那正是畫面上要標的範圍。
      expect(slice.startsWith(part.text.slice(0, 10))).toBe(true);
      expect(slice.endsWith(part.text.slice(-10))).toBe(true);
    }
  });

  it('序號是連續的，從 0 開始 —— **向量的 id 靠它**', () => {
    const text = `${ZH_LINE}\n分隔\n${ZH_LINE}\n分隔\n${ZH_LINE}`;
    const parts = chunkText(text);
    expect(parts.map((p) => p.ord)).toEqual(parts.map((_, i) => i));
  });

  it('行首的空白不算進範圍裡', () => {
    const text = `    ${ZH_LINE}`;
    const part = chunkText(text)[0];
    expect(part).toBeDefined();
    expect(text.slice(part?.start ?? 0, (part?.start ?? 0) + 2)).toBe(ZH_LINE.slice(0, 2));
  });
});

/**
 * 上限那一條。
 *
 * **它是預算決定的，不是品質決定的** —— 5 萬份 × 上限要落在
 * 「35 萬條向量」以內（`MAX_CHUNKS_PER_ITEM` 的註解）。
 * 而量測那一邊要傳 `Infinity`，否則語料會從 1955 段掉到 34×6 段。
 */
describe('每份文件的段數上限', () => {
  const many = Array.from({ length: 40 }, () => `${ZH_LINE}\n分隔`).join('\n');

  it('預設就是出貨的上限 —— **忘了傳的那一邊是安全的那一邊**', () => {
    expect(chunkText(many)).toHaveLength(MAX_CHUNKS_PER_ITEM);
  });

  it('傳 Infinity 就不設限（量測用的那條路）', () => {
    expect(chunkText(many, Infinity).length).toBeGreaterThan(MAX_CHUNKS_PER_ITEM);
  });

  /**
   * **這一條釘的是那個外推。** 5 萬筆 × 上限 ≤ 35 萬條
   * （2026-09-09 量到 5 萬條 2560 維是 69 ms，線性外推到 500 ms 的預算）。
   * 改上限而沒有重新量的話，Stage 13 的語意檢索預算會直接爆掉。
   */
  it('上限乘上 5 萬筆，要落在 500 ms 預算外推出來的條數以內', () => {
    const budgetRows = Math.floor((500 / 69) * 50_000);
    expect(MAX_CHUNKS_PER_ITEM * 50_000).toBeLessThanOrEqual(budgetRows);
  });
});
