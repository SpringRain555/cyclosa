/**
 * PDF 的文字層與頁碼。
 *
 * **每一頁的文字分開存**（ADR-0019）—— 點註的字元區間相對於「那一頁」，
 * 不是整份文件。整份文件的位移會被前面任何一頁的抽取差異推移，
 * **一頁抽錯會讓後面每一頁的錨點全部漂掉**。
 *
 * `page` 是 **1-based**（PDF 檔案結構就是這樣數的）。
 * 欄位名叫 `page` 而不是 `pageIndex` 是刻意的 —— 這是一個會反覆出錯的地方。
 */

import { reflowPage, type PdfTextItem } from './pdf-reflow.js';

export type PdfOutcome =
  | {
      readonly kind: 'ok';
      readonly pages: readonly string[];
      readonly title: string | null;
      /** 沒有任何一頁抽得出文字 —— 掃描件。**要說清楚，不是讓人以為工具壞了。** */
      readonly noTextLayer: boolean;
    }
  | { readonly kind: 'encrypted' }
  | { readonly kind: 'unreadable'; readonly reason: string };

/**
 * 動態載入 `pdfjs-dist`。
 *
 * **它只在真的遇到 PDF 時才被載進來** —— 這個套件不小，
 * 而大部分的匯入不是 PDF。啟動時間是一鍵啟動體驗的一部分。
 */
async function loadPdfjs(): Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

export async function extractPdf(bytes: Uint8Array): Promise<PdfOutcome> {
  let pdfjs: Awaited<ReturnType<typeof loadPdfjs>>;
  try {
    pdfjs = await loadPdfjs();
  } catch (e) {
    return { kind: 'unreadable', reason: `load-pdfjs: ${String((e as Error).message)}` };
  }

  try {
    const task = pdfjs.getDocument({
      // **複製一份。** pdfjs 會接管這塊記憶體（transfer），
      // 而快照的位元組在上層還要拿去算雜湊與寫檔。
      data: new Uint8Array(bytes),
      // PDF 是外部輸入 —— 不去載系統字型。抽文字層用不到字型。
      useSystemFonts: false,
    });
    const doc = await task.promise;

    const pages: string[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      const p = await doc.getPage(page);
      const content = await p.getTextContent();
      // **重排成段落**（v0.24.0，`pdf-reflow.ts`）：v1 是逐行硬換行，閱讀器上每一行都斷，
      // 抽取模型看到的引文也被切開。改了這裡就要 +1 `EXTRACTOR_VERSION`。
      // `items` 裡混著 marked-content 的標記（沒有 `str`），只留真的字塊。
      const textItems: PdfTextItem[] = [];
      for (const raw of content.items) {
        if ('str' in raw && typeof raw.str === 'string') textItems.push(raw);
      }
      pages.push(reflowPage(textItems));
    }

    const meta = await doc.getMetadata().catch(() => null);
    const info = meta?.info as { Title?: unknown } | undefined;
    const title =
      typeof info?.Title === 'string' && info.Title.trim().length > 0 ? info.Title.trim() : null;

    // **`destroy()` 在 loading task 上，不在 document 上。**
    // 少了它 pdfjs 的 worker 不會收掉，而 server 是長時間執行的。
    await task.destroy();

    return {
      kind: 'ok',
      pages,
      title,
      noTextLayer: pages.every((p) => p.length === 0),
    };
  } catch (e) {
    const err = e as { name?: string; message?: string };
    // pdfjs 用 `PasswordException` 表示需要密碼。**加密的 PDF 不是壞檔** ——
    // 它是一個我們決定不處理的東西，而使用者要看得出差別。
    if (err.name === 'PasswordException') return { kind: 'encrypted' };
    return { kind: 'unreadable', reason: String(err.message ?? e) };
  }
}
