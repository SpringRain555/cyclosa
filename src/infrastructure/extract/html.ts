/**
 * 網頁正文抽取：`linkedom` 給 DOM，`@mozilla/readability` 抽正文。
 *
 * **這一層只算訊號，不做判定** —— 判定在 `domain/ingest/extract-confidence.ts`，
 * 因為那是會出錯而且值得用純函式測的規則。
 */
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';

import {
  assessExtraction,
  looksJsOnly,
  type ConfidenceVerdict,
  type ExtractSignals,
} from '../../domain/ingest/extract-confidence.js';

export interface HtmlExtraction {
  readonly title: string;
  /** 純文字。**點註與引文的字元位移以它為準。** */
  readonly text: string;
  /** 重構後的排版，寫進 `derived/`。 */
  readonly html: string;
  readonly excerpt: string;
  readonly byline: string | null;
  readonly signals: ExtractSignals;
  readonly verdict: ConfidenceVerdict;
  /** 靜態抓不到內容（JS 才渲染）。**要明確標示，不是交出一份空正文。** */
  readonly jsOnly: boolean;
}

/** 把 DOM 的文字正規化成可讀的段落 —— 連續空白收斂，段落間留一個空行。 */
function tidyText(raw: string): string {
  return (
    raw
      .replace(/\r\n?/g, '\n')
      // 第三個是不換行空白（U+00A0）。**寫成跳脫序列而不是字元本身** ——
      // 一個看不見的空白混在字元類別裡，沒有人 review 得出來。
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .trim()
  );
}

/**
 * Readability 跑一次。
 *
 * **這個轉型是必要的，而且它是安全的。** server 端的 tsconfig 沒有 `lib.dom`
 * （後端不該有瀏覽器型別），所以 Readability 要的 `Document` 這裡叫不出名字；
 * 而 linkedom 的 document 本來就不是同一個型別，只是**行為相容** ——
 * 那正是 linkedom 存在的理由。
 */
function runReadability(document: unknown): ReturnType<Readability['parse']> {
  try {
    return new Readability(document as ConstructorParameters<typeof Readability>[0], {
      charThreshold: 250,
    }).parse();
  } catch {
    // 抓回來的 HTML 是外部輸入 —— 它壞到讓抽取器丟例外是可能的，
    // 而那要變成「抽取失敗」這個結果，不是一個往上炸的例外。
    return null;
  }
}

export function extractHtml(rawHtml: string, url: string): HtmlExtraction {
  const hasArticleTag = /<article[\s>]/i.test(rawHtml);

  // **`<article>` 要在 Readability 跑之前判斷** —— 它會改寫這份 DOM，
  // 跑完之後再問「原本有沒有 article」得到的是抽取後的答案。
  const { document } = parseHTML(rawHtml);

  const parsed = runReadability(document);

  const readabilityFailed = parsed === null;
  const articleHtml = parsed?.content ?? '';
  const text = tidyText(parsed?.textContent ?? '');

  // 連結密度與段落數要看**抽出來的那一塊**，不是整份文件。
  let paragraphCount = 0;
  let linkTextLength = 0;
  if (articleHtml.length > 0) {
    const { document: article } = parseHTML(`<body>${articleHtml}</body>`);
    paragraphCount = article.querySelectorAll('p').length;
    for (const a of article.querySelectorAll('a')) {
      linkTextLength += (a.textContent ?? '').length;
    }
  }

  const signals: ExtractSignals = {
    textLength: text.length,
    htmlLength: rawHtml.length,
    paragraphCount,
    linkDensity: text.length > 0 ? Math.min(1, linkTextLength / text.length) : 0,
    hasArticleTag,
    readabilityFailed,
  };

  const titleFromDoc = (document.querySelector('title')?.textContent ?? '').trim();

  return {
    title: (parsed?.title ?? '').trim() || titleFromDoc || url,
    text,
    html: articleHtml,
    excerpt: (parsed?.excerpt ?? '').trim(),
    byline: parsed?.byline?.trim() ?? null,
    signals,
    verdict: assessExtraction(signals),
    jsOnly: looksJsOnly(signals),
  };
}
