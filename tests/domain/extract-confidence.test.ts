import { describe, expect, it } from 'vitest';
import {
  assessExtraction,
  isEmptyContent,
  looksJsOnly,
  THRESHOLDS,
  type ExtractSignals,
} from '../../src/domain/ingest/extract-confidence.js';

/**
 * **這一份是 2026-09-07 那次量測的可執行版本。**
 *
 * 下面每一列都是一個真實頁面實際量到的訊號，`human` 那一欄是人工判讀
 * （「這份抽取結果拿去讀，讀到的是這一頁的內容，還是導覽／連結列／空白？」）。
 * 完整的 34 列與逐條推理在 `docs/research/extraction-confidence.md`。
 *
 * **調門檻的人會在這裡看到代價**：改一個常數，下面某一列就會翻面。
 */
const MEASURED: readonly { name: string; human: 'good' | 'bad'; s: ExtractSignals }[] = [
  {
    name: 'en.wikipedia.org',
    human: 'good',
    s: {
      textLength: 53489,
      htmlLength: 599826,
      paragraphCount: 87,
      linkDensity: 0.248,
      hasArticleTag: false,
      readabilityFailed: false,
    },
  },
  {
    name: 'zh.wikipedia.org',
    human: 'good',
    s: {
      textLength: 5172,
      htmlLength: 219414,
      paragraphCount: 22,
      linkDensity: 0.232,
      hasArticleTag: false,
      readabilityFailed: false,
    },
  },
  {
    name: 'github.com',
    human: 'good',
    s: {
      textLength: 6581,
      htmlLength: 347373,
      paragraphCount: 36,
      linkDensity: 0.017,
      hasArticleTag: true,
      readabilityFailed: false,
    },
  },
  {
    name: 'www.wikidata.org',
    human: 'good',
    s: {
      textLength: 11553,
      htmlLength: 1269315,
      paragraphCount: 669,
      linkDensity: 0,
      hasArticleTag: false,
      readabilityFailed: false,
    },
  },
  {
    name: 'httpbin.org',
    human: 'good',
    s: {
      textLength: 3596,
      htmlLength: 3739,
      paragraphCount: 1,
      linkDensity: 0,
      hasArticleTag: false,
      readabilityFailed: false,
    },
  },
  {
    name: 'curl.se',
    human: 'good',
    s: {
      textLength: 262109,
      htmlLength: 463795,
      paragraphCount: 2766,
      linkDensity: 0.075,
      hasArticleTag: false,
      readabilityFailed: false,
    },
  },

  {
    name: 'example.com',
    human: 'bad',
    s: {
      textLength: 111,
      htmlLength: 559,
      paragraphCount: 2,
      linkDensity: 0.09,
      hasArticleTag: false,
      readabilityFailed: false,
    },
  },
  {
    name: 'news.ycombinator.com',
    human: 'bad',
    s: {
      textLength: 3673,
      htmlLength: 34471,
      paragraphCount: 0,
      linkDensity: 0.791,
      hasArticleTag: false,
      readabilityFailed: false,
    },
  },
  {
    name: 'www.python.org',
    human: 'bad',
    s: {
      textLength: 292,
      htmlLength: 52474,
      paragraphCount: 3,
      linkDensity: 0.034,
      hasArticleTag: false,
      readabilityFailed: false,
    },
  },
  {
    name: 'ollama.com',
    human: 'bad',
    s: {
      textLength: 69,
      htmlLength: 71063,
      paragraphCount: 1,
      linkDensity: 0,
      hasArticleTag: false,
      readabilityFailed: false,
    },
  },
  {
    name: 'www.cna.com.tw',
    human: 'bad',
    s: {
      textLength: 4163,
      htmlLength: 161722,
      paragraphCount: 41,
      linkDensity: 0.995,
      hasArticleTag: false,
      readabilityFailed: false,
    },
  },
  {
    name: 'www.bbc.com',
    human: 'bad',
    s: {
      textLength: 1646,
      htmlLength: 365023,
      paragraphCount: 46,
      linkDensity: 1,
      hasArticleTag: true,
      readabilityFailed: false,
    },
  },
  {
    name: 'tw.stock.yahoo.com',
    human: 'bad',
    s: {
      textLength: 3590,
      htmlLength: 818284,
      paragraphCount: 46,
      linkDensity: 0.105,
      hasArticleTag: false,
      readabilityFailed: false,
    },
  },
  {
    name: 'danluu.com',
    human: 'bad',
    s: {
      textLength: 0,
      htmlLength: 22454,
      paragraphCount: 0,
      linkDensity: 0,
      hasArticleTag: false,
      readabilityFailed: true,
    },
  },

  // **這兩個是已知的漏報。** 兩個都可以靠調門檻抓到，
  // 而調到抓得到的位置就會開始誤報（研究文件裡有餘裕表）。
  {
    name: 'www.ptt.cc',
    human: 'bad',
    s: {
      textLength: 628,
      htmlLength: 19363,
      paragraphCount: 72,
      linkDensity: 0,
      hasArticleTag: false,
      readabilityFailed: false,
    },
  },
  {
    name: 'www.ithome.com.tw',
    human: 'bad',
    s: {
      textLength: 2842,
      htmlLength: 109674,
      paragraphCount: 91,
      linkDensity: 0.366,
      hasArticleTag: true,
      readabilityFailed: false,
    },
  },
];

const KNOWN_MISSES = ['www.ptt.cc', 'www.ithome.com.tw'];

describe('抽取信心（2026-09-07 量測的可執行版本）', () => {
  it('**一個誤報都沒有** —— 誤報會讓標記本身失去意義', () => {
    const falsePositives = MEASURED.filter(
      (row) => row.human === 'good' && assessExtraction(row.s).lowConfidence,
    ).map((row) => row.name);
    expect(falsePositives).toEqual([]);
  });

  it('漏報就是量測時記下的那兩個，不多也不少', () => {
    const misses = MEASURED.filter(
      (row) => row.human === 'bad' && !assessExtraction(row.s).lowConfidence,
    ).map((row) => row.name);
    expect(misses.sort()).toEqual([...KNOWN_MISSES].sort());
  });

  it('每一條規則都說得出理由', () => {
    expect(assessExtraction(MEASURED[6]!.s).reasons).toContain('too-short');
    expect(assessExtraction(MEASURED[7]!.s).reasons).toContain('link-heavy');
    expect(assessExtraction(MEASURED[8]!.s).reasons).toContain('thin-vs-html');
    expect(assessExtraction(MEASURED[13]!.s).reasons).toContain('readability-failed');
  });

  it('**`<article>` 保護長正文**：比例低但有 article 的不標低信心', () => {
    const withArticle: ExtractSignals = {
      textLength: 1000,
      htmlLength: 1_000_000,
      paragraphCount: 1,
      linkDensity: 0.1,
      hasArticleTag: true,
      readabilityFailed: false,
    };
    expect(assessExtraction(withArticle).lowConfidence).toBe(false);
    expect(assessExtraction({ ...withArticle, hasArticleTag: false }).reasons).toContain(
      'thin-vs-html',
    );
  });

  it('**段落數不再是規則**（它唯一的獨立貢獻是唯一的誤報）', () => {
    const oneParagraphArticle: ExtractSignals = {
      textLength: 3596,
      htmlLength: 3739,
      paragraphCount: 1,
      linkDensity: 0,
      hasArticleTag: false,
      readabilityFailed: false,
    };
    expect(assessExtraction(oneParagraphArticle).lowConfidence).toBe(false);
  });

  it('門檻的餘裕：Wikidata 離 thin-vs-html 只差 0.003', () => {
    const wikidata = MEASURED.find((r) => r.name === 'www.wikidata.org')!.s;
    const ratio = wikidata.textLength / wikidata.htmlLength;
    expect(ratio).toBeGreaterThan(THRESHOLDS.minTextToHtmlRatio);
    expect(ratio).toBeLessThan(0.01);
  });
});

describe('空正文與 JS-only 是兩件事', () => {
  it('完全沒有正文 → 空內容', () => {
    expect(isEmptyContent(MEASURED[13]!.s)).toBe(true);
    expect(isEmptyContent(MEASURED[0]!.s)).toBe(false);
  });

  it('**JS-only 只認「HTML 很大但文字幾乎沒有」**，不靠框架標記', () => {
    expect(looksJsOnly(MEASURED.find((r) => r.name === 'ollama.com')!.s)).toBe(true);
  });

  it('Readability 自己失敗的不算 JS-only —— 那是另一種毛病', () => {
    expect(looksJsOnly(MEASURED.find((r) => r.name === 'danluu.com')!.s)).toBe(false);
  });

  it('小而完整的頁面不是 JS-only', () => {
    expect(looksJsOnly(MEASURED.find((r) => r.name === 'example.com')!.s)).toBe(false);
  });

  it('34 頁裡只有一頁命中 —— **樣本只有 1 個陽性，不能說它準**', () => {
    expect(MEASURED.filter((r) => looksJsOnly(r.s))).toHaveLength(1);
  });
});
