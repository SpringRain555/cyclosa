/**
 * 版面檢視的選取 ↔ 正文的字元區間（`domain/annotation/layer-map.ts`）。
 *
 * **這一份測的是一個宣稱**：pdf.js 文字層的字（原樣）與 `derived/` 的正文（重排過）
 * 拿掉空白與連字號之後一字不差 —— 所以選取可以逐字對回去，不用猜。
 * 正文用真的 `reflowPage` 產生，不是手寫一份「應該長這樣」的字串；
 * 重排哪天多做了一件會改變骨架的事，這裡會紅。
 */
import { describe, expect, it } from 'vitest';

import {
  mapAcross,
  mapBetween,
  MIN_AMBIGUOUS_CHARS,
  skeletonOf,
} from '../../src/domain/annotation/layer-map.js';
import { reflowPage, type PdfTextItem } from '../../src/infrastructure/extract/pdf-reflow.js';

const H = 10;

function line(str: string, y: number, x = 50, width = str.length * 5): PdfTextItem {
  return { str, transform: [H, 0, 0, H, x, y], width, height: H, hasEOL: true };
}

/** 文字層上的字：pdf.js 的 TextLayer 一個字塊一個 span，`hasEOL` 是 `<br>`（不是字）。 */
function layerTextOf(items: readonly PdfTextItem[]): string {
  return items.map((item) => item.str).join('');
}

const ITEMS: readonly PdfTextItem[] = [
  line('Reconfigurable intelligent sur-', 700),
  line('faces steer the reflected signal', 688),
  line('toward the user terminal.', 676),
  line('A second paragraph begins here', 640, 58),
  line('and repeats the reflected signal.', 628),
];

describe('骨架一字不差：逐字對應', () => {
  const page = reflowPage(ITEMS);
  const layer = layerTextOf(ITEMS);

  it('前提：重排之後的正文與文字層的骨架相同', () => {
    expect(page).toContain('surfaces steer');
    expect(skeletonOf(layer).chars).toBe(skeletonOf(page).chars);
  });

  it('跨過一個被接起來的斷字，對回正文裡接好的那一段', () => {
    const from = layer.indexOf('intelligent');
    const to = layer.indexOf('steer') + 'steer'.length;
    const hit = mapAcross(layer, page, from, to);
    expect(hit.kind).toBe('aligned');
    if (hit.kind === 'not-found') return;
    expect(page.slice(hit.start, hit.end)).toBe('intelligent surfaces steer');
  });

  it('反方向（畫高亮）：正文的一段對回文字層上同一串字', () => {
    const start = page.indexOf('toward the user');
    const end = start + 'toward the user'.length;
    const hit = mapAcross(page, layer, start, end);
    expect(hit.kind).toBe('aligned');
    if (hit.kind === 'not-found') return;
    expect(layer.slice(hit.start, hit.end)).toBe('toward the user');
  });

  it('頭尾選到的空白不算進去：區間落在真的有字的地方', () => {
    const from = layer.indexOf(' steer');
    const to = layer.indexOf('steer') + 'steer '.length;
    const hit = mapAcross(layer, page, from, to);
    if (hit.kind === 'not-found') throw new Error('應該找得到');
    expect(page.slice(hit.start, hit.end)).toBe('steer');
  });

  it('只選到空白：沒有字可以對，就說找不到', () => {
    const at = layer.indexOf(' steer');
    expect(mapAcross(layer, page, at, at + 1)).toEqual({ kind: 'not-found' });
    expect(mapAcross(layer, page, 5, 5)).toEqual({ kind: 'not-found' });
  });

  it('中日韓：接行不補空白，照樣一字不差', () => {
    const cjk = [line('可重構智慧表面把反射', 700), line('訊號導向使用者終端。', 688)];
    const cjkPage = reflowPage(cjk);
    const cjkLayer = layerTextOf(cjk);
    const from = cjkLayer.indexOf('反射');
    const to = cjkLayer.indexOf('導向') + 2;
    const hit = mapAcross(cjkLayer, cjkPage, from, to);
    if (hit.kind === 'not-found') throw new Error('應該找得到');
    expect(hit.kind).toBe('aligned');
    expect(cjkPage.slice(hit.start, hit.end)).toBe('反射訊號導向');
  });
});

describe('骨架不同：靠找的，而且不猜', () => {
  // 正文比文字層多一行（例如舊版抽取器留下的頁首）—— 骨架對不上，只能找。
  const layer = layerTextOf(ITEMS);
  const page = `IEEE TRANSACTIONS 2026\n\n${reflowPage(ITEMS)}`;

  it('只出現一次的片段：找得到就是它', () => {
    const from = layer.indexOf('toward');
    const to = layer.indexOf('terminal') + 'terminal'.length;
    const hit = mapAcross(layer, page, from, to);
    expect(hit.kind).toBe('searched');
    if (hit.kind === 'not-found') return;
    expect(page.slice(hit.start, hit.end)).toBe('toward the user terminal');
  });

  it('出現兩次的長片段：取位置比例最接近的那一處', () => {
    // 「the reflected signal」在第一段與第二段各一次；選的是第二段那一次。
    const second = layer.lastIndexOf('the reflected signal');
    const hit = mapAcross(layer, page, second, second + 'the reflected signal'.length);
    expect('thereflectedsignal'.length).toBeGreaterThanOrEqual(MIN_AMBIGUOUS_CHARS);
    if (hit.kind === 'not-found') throw new Error('應該找得到');
    expect(hit.start).toBe(page.lastIndexOf('the reflected signal'));
  });

  it('出現兩次的短片段：不猜，說找不到', () => {
    const second = layer.lastIndexOf('the');
    expect(mapAcross(layer, page, second, second + 3)).toEqual({ kind: 'not-found' });
  });

  it('正文裡根本沒有：說找不到，不錨到別處', () => {
    const odd = 'Completely different words';
    expect(mapAcross(odd, page, 0, odd.length)).toEqual({ kind: 'not-found' });
  });

  it('骨架算一次、用很多次：跟一次性的版本同一個答案', () => {
    const s = skeletonOf(layer);
    const t = skeletonOf(page);
    const from = layer.indexOf('surfaces') - 4;
    expect(mapBetween(s, t, from, from + 12)).toEqual(mapAcross(layer, page, from, from + 12));
  });
});
