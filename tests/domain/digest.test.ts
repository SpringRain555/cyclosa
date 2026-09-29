/**
 * 初讀的輸出正規化（Stage 21，ADR-0033 D9）。
 *
 * 模型的輸出是外部輸入：`relevance` 不是三個值之一的整份不採用 —— 一個猜出來的「有關」
 * 會變成確認畫面上「進圖」的預設值（D10），那是這個欄位唯一的用途。
 */
import { describe, expect, it } from 'vitest';

import {
  DIGEST_TEXT_CHARS,
  MAX_DIGEST_SUMMARY_CHARS,
  MAX_DIGEST_TITLE_CHARS,
  digestExcerpt,
  normalizeDigest,
} from '../../src/domain/provider/digest.js';

describe('normalizeDigest', () => {
  it('三個值之一 ＋ 有標題或摘要 → 收下', () => {
    const d = normalizeDigest({
      relevance: 'yes',
      why: '  講的就是這條方向的評測方法 ',
      title_zh: '建立代理評測基準',
      summary_zh: '這篇提出一套評測流程。',
    });
    expect(d).toEqual({
      relevance: 'yes',
      why: '講的就是這條方向的評測方法',
      titleZh: '建立代理評測基準',
      summaryZh: '這篇提出一套評測流程。',
    });
  });

  it('`relevance` 不是三個值之一 → 整份不採用', () => {
    for (const bad of ['Yes', 'maybe', '', null, 1, undefined]) {
      expect(normalizeDigest({ relevance: bad, title_zh: '標題', summary_zh: '摘要' })).toBeNull();
    }
  });

  it('標題與摘要兩個都空 → 不採用（畫面上的「繁中」會是一片空白）', () => {
    expect(
      normalizeDigest({ relevance: 'no', why: '無關', title_zh: ' ', summary_zh: '' }),
    ).toBeNull();
  });

  it('只有其中一個也收（原文標題已經是繁中的時候，模型可能只給摘要）', () => {
    expect(
      normalizeDigest({ relevance: 'unsure', title_zh: '', summary_zh: '一段摘要。' }),
    ).not.toBeNull();
  });

  it('超長的切到上限 —— 摘要的上限是為了讓它不變成全文翻譯（R16）', () => {
    const d = normalizeDigest({
      relevance: 'yes',
      title_zh: '題'.repeat(MAX_DIGEST_TITLE_CHARS + 50),
      summary_zh: '摘'.repeat(MAX_DIGEST_SUMMARY_CHARS + 50),
    });
    expect(d?.titleZh).toHaveLength(MAX_DIGEST_TITLE_CHARS);
    expect(d?.summaryZh).toHaveLength(MAX_DIGEST_SUMMARY_CHARS);
  });

  it('不是物件 → null，不丟例外', () => {
    for (const bad of [null, undefined, 'yes', 42, []]) expect(normalizeDigest(bad)).toBeNull();
  });
});

describe('digestExcerpt', () => {
  it('送出去的是開頭，切在上限', () => {
    const body = `  ${'甲'.repeat(DIGEST_TEXT_CHARS + 100)}`;
    expect(digestExcerpt(body)).toHaveLength(DIGEST_TEXT_CHARS);
    expect(digestExcerpt('短的')).toBe('短的');
  });
});
