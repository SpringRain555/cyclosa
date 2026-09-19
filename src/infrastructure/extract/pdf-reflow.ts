/**
 * PDF 文字層的重排：把 pdf.js 吐出來的一串「字塊」接成段落。
 *
 * ## 為什麼要重排
 *
 * pdf.js 的 `getTextContent()` 給的是排版時的字塊，**每一行是一個硬換行**，
 * 連字號斷字（`com-` ＋ `ponents`）也照原樣。v0.23.0 之前直接把它們接起來，
 * 閱讀器上每一行都硬斷（2026-09-18 使用者：「排版不如原本」），
 * 而抽取模型看到的引文也被硬換行切開 —— `locateQuote` 對不上原文的機會因此變高。
 *
 * ## 規則（都是量得到的幾何，不看字）
 *
 * 1. **行**：字塊照 pdf.js 給的順序走（那是內容流的順序，雙欄論文左欄走完才右欄），
 *    `hasEOL` 或基線 y 變了就換行。同一行裡兩個字塊之間有縫（超過 0.2 個字高）就補一個空白。
 * 2. **段落**：兩行之間的垂直距離小於 `PARAGRAPH_GAP`（1.5）倍行高就是同一段；
 *    往上跳（下一欄、下一區）、字高變了（標題）、下一行縮排、上一行明顯沒寫滿
 *    （不到下一行寬度的六成）都是段落邊界。
 * 3. **接行**：上一行以 `-` 結尾而下一行以小寫字母開頭 → 去掉連字號直接接；
 *    兩邊都是中日韓字 → 直接接；其餘補一個空白。
 *
 * ## 什麼不做
 *
 * 不重排表格、不合併欄位、不猜閱讀順序 —— 內容流的順序就是輸出的順序。
 * 這一支是純函式，沒有 I/O，`tests/infrastructure/pdf-reflow.test.ts` 用合成的字塊測。
 */

/** pdf.js `TextItem` 裡這一支會看的欄位。 */
export interface PdfTextItem {
  readonly str: string;
  /** `[a, b, c, d, x, y]`；x 是左緣、y 是基線（PDF 座標，往上是正）。 */
  readonly transform: readonly number[];
  readonly width: number;
  readonly height: number;
  readonly hasEOL: boolean;
}

interface Line {
  text: string;
  x: number;
  right: number;
  y: number;
  h: number;
}

/** 行距超過行高的幾倍就當段落邊界。一般行距 1.15–1.3，段落間距通常再加半行以上。 */
export const PARAGRAPH_GAP = 1.5;

const CJK = new RegExp(
  '[' +
    [
      '\\u3000-\\u303f',
      '\\u3040-\\u30ff',
      '\\u3400-\\u4dbf',
      '\\u4e00-\\u9fff',
      '\\uf900-\\ufaff',
      '\\uff00-\\uffef',
    ].join('') +
    ']',
);

function linesOf(items: readonly PdfTextItem[]): Line[] {
  const lines: Line[] = [];
  let current: Line | null = null;
  const flush = (): void => {
    if (current !== null && current.text.trim().length > 0) {
      lines.push({ ...current, text: current.text.replace(/\s+/g, ' ').trim() });
    }
    current = null;
  };
  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const x = Number(item.transform[4] ?? 0);
    const y = Number(item.transform[5] ?? 0);
    const h = Math.max(Number(item.height) || 0, Math.abs(Number(item.transform[3]) || 0));
    const isBlank = item.str.trim().length === 0;
    if (current !== null && Math.abs(current.y - y) > Math.max(current.h, h) * 0.5) flush();
    if (current === null) {
      if (isBlank) {
        if (item.hasEOL) flush();
        continue;
      }
      current = { text: item.str, x, right: x + item.width, y, h };
    } else {
      // 同一行：兩個字塊之間有縫就補一個空白（pdf.js 有時把空白當成獨立字塊、有時省略）。
      const gap = x - current.right;
      const needsSpace =
        gap > Math.max(current.h, h) * 0.2 &&
        !current.text.endsWith(' ') &&
        !item.str.startsWith(' ');
      current.text += (needsSpace ? ' ' : '') + item.str;
      current.right = Math.max(current.right, x + item.width);
      current.h = Math.max(current.h, h);
    }
    if (item.hasEOL) flush();
  }
  flush();
  return lines;
}

/** 上一行與這一行之間是不是段落邊界。 */
function breaksParagraph(prev: Line, line: Line): boolean {
  const h = Math.max(prev.h, line.h, 1);
  const gap = prev.y - line.y;
  // 往上跳：換欄、換區塊。
  if (gap <= 0) return true;
  // 空了一行以上。
  if (gap > h * PARAGRAPH_GAP) return true;
  // 字高變了：標題與正文之間。
  if (Math.abs(prev.h - line.h) > h * 0.15) return true;
  // 縮排：這一行比上一行縮進去（首行縮排是段落的開頭）。
  if (line.x - prev.x > h * 0.8) return true;
  // 上一行明顯沒寫滿（不到下一行寬度的六成）：段落的最後一行。
  // **拿下一行當基準，不拿整頁最寬的那一行** —— 雙欄論文的每一行都只有標題的一半寬，
  // 拿標題當基準的話每一行都會被判成「沒寫滿」。
  const nextWidth = line.right - line.x;
  if (nextWidth > 0 && prev.right - prev.x < nextWidth * 0.6) return true;
  return false;
}

function join(prev: string, next: string): string {
  const last = prev.at(-1) ?? '';
  const first = next.at(0) ?? '';
  // 連字號斷字：`com-` ＋ `ponents` → `components`。只在下一行以小寫開頭時才接，
  // `state-of-the-art` 這種真的連字號會被保住（下一行是新句子時多半大寫或數字）。
  if (last === '-' && /[a-z]/.test(first)) return prev.slice(0, -1) + next;
  if (CJK.test(last) && CJK.test(first)) return prev + next;
  return `${prev} ${next}`;
}

/**
 * 一頁的字塊 → 段落用空一行隔開的純文字。
 *
 * **輸出裡沒有硬換行**（段落內全部接成一行），所以閱讀器的段落切分（`\n{2,}`）
 * 與抽取模型看到的引文都是完整的句子。
 */
export function reflowPage(items: readonly PdfTextItem[]): string {
  const lines = linesOf(items);
  if (lines.length === 0) return '';
  const paragraphs: string[] = [];
  let current = '';
  let prev: Line | null = null;
  for (const line of lines) {
    if (prev === null) {
      current = line.text;
    } else if (breaksParagraph(prev, line)) {
      paragraphs.push(current);
      current = line.text;
    } else {
      current = join(current, line.text);
    }
    prev = line;
  }
  paragraphs.push(current);
  return paragraphs
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join('\n\n');
}
