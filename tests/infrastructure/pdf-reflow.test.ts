/**
 * PDF 文字層的重排（`extract/pdf-reflow.ts`）。
 *
 * 用合成的字塊測 —— 這一支是純幾何，不需要一份真的 PDF。
 * 幾何是 pdf.js 的座標：`transform[4]` 是左緣、`transform[5]` 是基線，y 往上是正。
 */
import { describe, expect, it } from 'vitest';

import {
  PARAGRAPH_GAP,
  reflowPage,
  type PdfTextItem,
} from '../../src/infrastructure/extract/pdf-reflow.js';

const H = 10;

/** 一行字：`x` 左緣、`y` 基線、`str` 內容、`width` 預設每字 5 單位。 */
function line(str: string, y: number, x = 50, width = str.length * 5): PdfTextItem {
  return { str, transform: [H, 0, 0, H, x, y], width, height: H, hasEOL: true };
}

describe('行接成段落', () => {
  it('行距正常的幾行接成一段，沒有硬換行', () => {
    const text = reflowPage([
      line('The quick brown fox jumps', 700),
      line('over the lazy dog and keeps', 688),
      line('running.', 676),
    ]);
    expect(text).toBe('The quick brown fox jumps over the lazy dog and keeps running.');
    expect(text).not.toContain('\n');
  });

  it('連字號斷字接回去；真的連字號（下一行大寫）保留', () => {
    const joined = reflowPage([line('autonomous com-', 700), line('ponents of the system', 688)]);
    expect(joined).toBe('autonomous components of the system');
    const kept = reflowPage([line('a state-of-the-art re-', 700), line('Ranking method', 688)]);
    expect(kept).toBe('a state-of-the-art re- Ranking method');
  });

  it('中日韓字之間不補空白', () => {
    expect(reflowPage([line('這是第一行的內容', 700), line('接著第二行', 688)])).toBe(
      '這是第一行的內容接著第二行',
    );
  });

  it('空了一行以上就是段落邊界', () => {
    const text = reflowPage([
      line('First paragraph line one', 700),
      line('first paragraph line two', 688),
      line('Second paragraph starts here', 688 - H * PARAGRAPH_GAP - 2),
    ]);
    expect(text.split('\n\n')).toEqual([
      'First paragraph line one first paragraph line two',
      'Second paragraph starts here',
    ]);
  });

  it('字高變了（標題）、縮排（新段落的第一行）都是邊界', () => {
    const heading: PdfTextItem = {
      str: 'II. Related Work',
      transform: [16, 0, 0, 16, 50, 700],
      width: 120,
      height: 16,
      hasEOL: true,
    };
    const text = reflowPage([
      heading,
      line('Body text follows the heading and', 682),
      line('continues on the next line fully.', 670),
      line('Indented first line of a new one', 658, 62),
    ]);
    expect(text.split('\n\n')).toEqual([
      'II. Related Work',
      'Body text follows the heading and continues on the next line fully.',
      'Indented first line of a new one',
    ]);
  });

  it('上一行明顯沒寫滿（段落最後一行）就是邊界，而基準是那一欄的寬度、不是整頁', () => {
    // 雙欄：左欄 x=50、右欄 x=300，各 200 寬；一條跨頁的標題 500 寬。
    const items: PdfTextItem[] = [
      {
        str: 'A Wide Title Across Both Columns',
        transform: [16, 0, 0, 16, 50, 760],
        width: 500,
        height: 16,
        hasEOL: true,
      },
      line('Left column line one is full width', 700, 50, 200),
      line('left column line two is full width', 688, 50, 200),
      line('short end.', 676, 50, 40),
      line('Left column next paragraph starts', 664, 50, 200),
      // 右欄：往上跳 → 一定是邊界。
      line('Right column line one is full width', 700, 300, 200),
      line('right column line two is full width', 688, 300, 200),
    ];
    expect(reflowPage(items).split('\n\n')).toEqual([
      'A Wide Title Across Both Columns',
      'Left column line one is full width left column line two is full width short end.',
      'Left column next paragraph starts',
      'Right column line one is full width right column line two is full width',
    ]);
  });

  it('同一行裡的字塊：有縫就補空白，沒縫直接接', () => {
    const items: PdfTextItem[] = [
      { str: 'Hello', transform: [H, 0, 0, H, 50, 700], width: 25, height: H, hasEOL: false },
      // 縫 10 單位 > 0.2 個字高 → 補空白
      { str: 'world', transform: [H, 0, 0, H, 85, 700], width: 25, height: H, hasEOL: false },
      // 緊接著 → 不補
      { str: '!', transform: [H, 0, 0, H, 110, 700], width: 3, height: H, hasEOL: true },
    ];
    expect(reflowPage(items)).toBe('Hello world!');
  });

  it('空白字塊與空頁', () => {
    expect(reflowPage([])).toBe('');
    expect(
      reflowPage([
        { str: ' ', transform: [H, 0, 0, H, 50, 700], width: 3, height: H, hasEOL: true },
      ]),
    ).toBe('');
  });
});
