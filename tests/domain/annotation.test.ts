/**
 * 點註的錨點（Stage 10）。
 *
 * **這一份測的不是「函式會不會回東西」，是三條規則各自的反例：**
 *
 * 1. 錨點解析**不會錨到錯的地方** —— 重複的引文靠前後文分辨。
 * 2. 抽取器換版之後錨點**跟著文字走**，不是停在舊的位置上。
 * 3. 對不上的時候**說對不上**，不猜一個看起來合理的位置。
 */
import { describe, expect, it } from 'vitest';

import {
  anchorOk,
  imageSelector,
  MEDIA_FRAGMENT,
  parseSelectors,
  PDF_FRAGMENT,
  pdfSelectors,
  pickPage,
  pickPosition,
  pickQuote,
  pickRect,
  resolveAnchor,
  resolveInImage,
  resolveInPdf,
  resolveInText,
  textSelectors,
  type Selector,
} from '../../src/domain/annotation/index.js';
import { findAll, squash } from '../../src/domain/text/offsets.js';

const TEXT =
  '第一段講的是蜘蛛網上的裝飾物。研究者在台中霧社坑觀察了三年。\n\n' +
  '第二段又講了一次蜘蛛網上的裝飾物，但這一次的結論相反。';

function selectorsFor(text: string, needle: string, occurrence = 0): readonly Selector[] {
  const spans = findAll(text, needle);
  const span = spans[occurrence];
  if (span === undefined) throw new Error(`找不到第 ${String(occurrence)} 個「${needle}」`);
  const built = textSelectors(text, span.start, span.end);
  if (built.kind !== 'ok') throw new Error(built.kind);
  return built.selectors;
}

describe('壓空白的座標對照（domain/text）', () => {
  it('回報的位置落在原文的座標上，不是壓過之後的', () => {
    const text = 'a  \n b';
    const flat = squash(text);
    expect(flat.flat).toBe('a b');
    // 壓過之後的第 2 個字元（'b'）在原文是第 5 個。
    expect(flat.map[2]).toBe(5);
  });

  it('空白不一樣也找得到，而區間頭尾都落在有字的地方', () => {
    const found = findAll('前面 一 二 三 後面', '一  二   三');
    expect(found).toHaveLength(1);
    expect('前面 一 二 三 後面'.slice(found[0]?.start, found[0]?.end)).toBe('一 二 三');
  });

  it('每一個出現位置都回，不是只回第一個', () => {
    // **這一條是點註能不能分辨重複引文的前提。**
    expect(findAll('甲乙丙甲乙丙甲乙', '甲乙')).toHaveLength(3);
  });
});

describe('建立選擇器', () => {
  it('文字：位置與引文兩個都存（ADR-0010）', () => {
    const built = textSelectors(TEXT, 0, 6);
    expect(built.kind).toBe('ok');
    if (built.kind !== 'ok') return;
    expect(pickQuote(built.selectors)?.exact).toBe('第一段講的是');
    expect(pickPosition(built.selectors)).toEqual({
      type: 'TextPositionSelector',
      start: 0,
      end: 6,
    });
  });

  it('文字：前後文從同一份文字取，所以它跟引文一起漂或一起不漂', () => {
    const built = textSelectors(TEXT, 6, 16);
    if (built.kind !== 'ok') throw new Error(built.kind);
    const quote = pickQuote(built.selectors);
    expect(quote?.prefix).toBe('第一段講的是');
    expect(quote?.suffix?.length).toBeGreaterThan(0);
  });

  it.each([
    ['選太短', () => textSelectors(TEXT, 0, 1), 'too-short'],
    ['只選到空白', () => textSelectors('甲 \n 乙', 1, 4), 'too-short'],
    ['反向區間', () => textSelectors(TEXT, 10, 5), 'out-of-range'],
    ['超出結尾', () => textSelectors(TEXT, 0, TEXT.length + 1), 'out-of-range'],
    ['太長', () => textSelectors('甲'.repeat(3000), 0, 2500), 'too-long'],
  ])('%s → %s', (_name, build, expected) => {
    expect(build().kind).toBe(expected);
  });

  it('PDF：頁碼在外，字元區間在 refinedBy 裡（ADR-0019）', () => {
    const built = pdfSelectors('這一頁講了蜘蛛網的裝飾物。', 3, 5, 12);
    if (built.kind !== 'ok') throw new Error(built.kind);

    expect(pickPage(built.selectors)).toBe(3);
    // **區間相對於那一頁**，不是整份文件 —— 所以它是個小數字。
    expect(pickPosition(built.selectors)).toEqual({
      type: 'TextPositionSelector',
      start: 5,
      end: 12,
    });
    const fragment = built.selectors.find((s) => s.type === 'FragmentSelector');
    expect(fragment).toMatchObject({ conformsTo: PDF_FRAGMENT, value: '#page=3' });
  });

  it('PDF：頁碼是 1-based，0 頁不存在', () => {
    expect(pdfSelectors('內容', 0, 0, 2).kind).toBe('out-of-range');
  });

  it('圖片：pixel 不是 percent（ADR-0019）', () => {
    const built = imageSelector({ x: 10, y: 20, w: 30, h: 40 }, 100, 100);
    if (built.kind !== 'ok') throw new Error(built.kind);
    const fragment = built.selectors[0];
    expect(fragment).toMatchObject({
      conformsTo: MEDIA_FRAGMENT,
      value: '#xywh=pixel:10,20,30,40',
    });
  });

  it('圖片：框到圖外面一律拒絕，不夾進邊界', () => {
    // 夾進邊界的話會存下一個**看起來合理但不是使用者框的**矩形。
    expect(imageSelector({ x: 90, y: 0, w: 20, h: 10 }, 100, 100).kind).toBe('out-of-range');
    expect(imageSelector({ x: 0, y: 0, w: 0, h: 10 }, 100, 100).kind).toBe('too-short');
  });
});

describe('讀回選擇器：壞掉的當作沒有', () => {
  it.each([
    ['不是 JSON', 'not json'],
    ['不是陣列', '{"type":"TextQuoteSelector"}'],
    ['空字串', ''],
  ])('%s → 空陣列', (_name, json) => {
    expect(parseSelectors(json)).toEqual([]);
  });

  it('壞掉一個不會把好的那個一起帶走', () => {
    const json = JSON.stringify([
      { type: 'TextPositionSelector', start: 10, end: 3 },
      { type: 'TextQuoteSelector', exact: '蜘蛛網', prefix: '', suffix: '' },
    ]);
    const parsed = parseSelectors(json);
    expect(pickPosition(parsed)).toBeNull();
    expect(pickQuote(parsed)?.exact).toBe('蜘蛛網');
  });

  it.each([
    ['反向區間', { type: 'TextPositionSelector', start: 9, end: 4 }],
    ['負的起點', { type: 'TextPositionSelector', start: -1, end: 4 }],
    ['小數', { type: 'TextPositionSelector', start: 1.5, end: 4 }],
    ['空區間', { type: 'TextPositionSelector', start: 4, end: 4 }],
  ])('荒謬的位置（%s）當作沒有', (_name, selector) => {
    expect(pickPosition(parseSelectors(JSON.stringify([selector])))).toBeNull();
  });

  it('矩形的四個數字要齊全而且是整數', () => {
    const bad = JSON.stringify([
      { type: 'FragmentSelector', conformsTo: MEDIA_FRAGMENT, value: '#xywh=pixel:1,2,3' },
    ]);
    expect(pickRect(parseSelectors(bad))).toBeNull();
  });

  it('百分比的矩形不收 —— 這個專案只寫 pixel', () => {
    const percent = JSON.stringify([
      { type: 'FragmentSelector', conformsTo: MEDIA_FRAGMENT, value: '#xywh=percent:1,2,3,4' },
    ]);
    expect(pickRect(parseSelectors(percent))).toBeNull();
  });
});

describe('解析：位置對得上就是 exact', () => {
  it('文字沒動過 → exact，而且區間就是當初存的那個', () => {
    const sel = selectorsFor(TEXT, '台中霧社坑');
    const hit = resolveInText(TEXT, sel);
    expect(hit.kind).toBe('exact');
    if (hit.kind !== 'exact') return;
    expect(TEXT.slice(hit.start, hit.end)).toBe('台中霧社坑');
  });

  it('位置對得上但那裡的字不是引文 → 不採信那個位置', () => {
    // **這是最重要的一條**：位置沒有被驗過就不能用。
    const sel = parseSelectors(
      JSON.stringify([
        { type: 'TextQuoteSelector', exact: '台中霧社坑', prefix: '', suffix: '' },
        { type: 'TextPositionSelector', start: 0, end: 5 },
      ]),
    );
    const hit = resolveInText(TEXT, sel);
    expect(hit.kind).toBe('shifted');
    if (hit.kind !== 'shifted') return;
    expect(TEXT.slice(hit.start, hit.end)).toBe('台中霧社坑');
  });
});

describe('解析：重複的引文靠前後文分辨', () => {
  const REPEATED = '蜘蛛網上的裝飾物';

  it('第二次出現的那一段，重抽之後仍然錨在第二次', () => {
    // 存的是第 2 個（occurrence 1）。
    const sel = selectorsFor(TEXT, REPEATED, 1);
    const second = findAll(TEXT, REPEATED)[1];

    // 在前面插一段字 —— 這就是「抽取器換版讓整份文字位移」的最小模型。
    const shiftedText = `（編按：以下為重新抽取的版本）\n\n${TEXT}`;
    const hit = resolveInText(shiftedText, sel);

    expect(hit.kind).toBe('shifted');
    if (hit.kind !== 'shifted') return;
    expect(shiftedText.slice(hit.start, hit.end)).toBe(REPEATED);
    // **關鍵**：它落在第二次那一段上，不是第一次。
    const offset = shiftedText.length - TEXT.length;
    expect(hit.start).toBe((second?.start ?? -1) + offset);
  });

  it('沒有前後文可用時仍然不會亂挑 —— 挑離原位置最近的那個', () => {
    const noContext = parseSelectors(
      JSON.stringify([
        { type: 'TextQuoteSelector', exact: REPEATED, prefix: '', suffix: '' },
        { type: 'TextPositionSelector', start: 999, end: 1007 },
      ]),
    );
    const hit = resolveInText(TEXT, noContext);
    expect(hit.kind).toBe('shifted');
    if (hit.kind !== 'shifted') return;
    // 999 離第二次比較近。
    expect(hit.start).toBe(findAll(TEXT, REPEATED)[1]?.start);
  });
});

describe('解析：找不到就說找不到', () => {
  it('引文整段被抽掉了 → not-found，而不是挑一個相近的', () => {
    const sel = selectorsFor(TEXT, '台中霧社坑');
    expect(resolveInText('完全不一樣的一份文字。', sel).kind).toBe('not-found');
  });

  it('只有位置沒有引文 → not-found', () => {
    // 沒有引文就**沒有辦法驗**，而一個沒驗過的位置長得跟驗過的一樣。
    const sel = parseSelectors(
      JSON.stringify([{ type: 'TextPositionSelector', start: 0, end: 6 }]),
    );
    expect(resolveInText(TEXT, sel).kind).toBe('not-found');
  });

  it('同一句話出現太多次 → 不挑', () => {
    const many = '甲乙丙'.repeat(500);
    const sel = selectorsFor(many, '甲乙丙', 0);
    // 前後文在這種文字裡完全無效：每一個候選的前後文都一樣。
    expect(resolveInText(many, sel).kind).toBe('exact');
    // 但位置對不上的時候就分不出來了，而那時候該停手。
    const shifted = parseSelectors(
      JSON.stringify([
        { type: 'TextQuoteSelector', exact: '甲乙丙', prefix: '甲乙丙', suffix: '甲乙丙' },
        { type: 'TextPositionSelector', start: 99_999, end: 100_002 },
      ]),
    );
    expect(resolveInText(many, shifted).kind).toBe('not-found');
  });
});

describe('解析：PDF', () => {
  const PAGES = ['第一頁講了蜘蛛網的裝飾物。', '第二頁講了別的東西。', '第三頁又回來講裝飾物。'];

  it('在記著的那一頁裡找到 → exact，而且頁碼回 1-based', () => {
    const built = pdfSelectors(PAGES[1] as string, 2, 0, 6);
    if (built.kind !== 'ok') throw new Error(built.kind);
    const hit = resolveInPdf(PAGES, built.selectors);
    expect(hit).toMatchObject({ kind: 'exact', page: 2 });
  });

  it('那一段掉到隔壁頁 → shifted，而且頁碼跟著改', () => {
    const built = pdfSelectors(PAGES[1] as string, 2, 0, 6);
    if (built.kind !== 'ok') throw new Error(built.kind);
    // 重抽之後那一段掉到第 3 頁。
    const repaginated = [PAGES[0] as string, '（這一頁變成別的東西）', PAGES[1] as string];
    const hit = resolveInPdf(repaginated, built.selectors);
    expect(hit).toMatchObject({ kind: 'shifted', page: 3 });
  });

  it('**不掃整份文件** —— 隔壁頁以外的不算找到', () => {
    const built = pdfSelectors('目標句子在這裡。', 1, 0, 8);
    if (built.kind !== 'ok') throw new Error(built.kind);
    const faraway = ['甲', '乙', '丙', '丁', '目標句子在這裡。'];
    // 它真的在第 5 頁，但那已經不是「漂了一點」，是另一個位置。
    expect(resolveInPdf(faraway, built.selectors).kind).toBe('not-found');
  });

  it('沒有頁碼片段的選擇器不能當 PDF 解', () => {
    expect(resolveInPdf(PAGES, selectorsFor(TEXT, '台中霧社坑')).kind).toBe('not-found');
  });
});

describe('解析：圖片', () => {
  const built = imageSelector({ x: 10, y: 10, w: 50, h: 50 }, 200, 100);
  const selectors = built.kind === 'ok' ? built.selectors : [];

  it('尺寸對得上 → rect', () => {
    expect(resolveInImage(selectors, 200, 100)).toEqual({
      kind: 'rect',
      rect: { x: 10, y: 10, w: 50, h: 50 },
    });
  });

  it('快照換了一張比較小的 → not-found，不把框夾進去', () => {
    // 圖片**沒有第二重錨點**，所以這裡只能誠實地說對不上。
    expect(resolveInImage(selectors, 40, 40).kind).toBe('not-found');
  });

  it('尺寸不知道就放行 —— 舊的匯入沒記尺寸，那不是這則點註的錯', () => {
    expect(resolveInImage(selectors, null, null).kind).toBe('rect');
  });
});

describe('分派與 anchor_ok', () => {
  it('依來源型別走三條路', () => {
    const textSel = selectorsFor(TEXT, '台中霧社坑');
    expect(
      resolveAnchor({ kind: 'web', text: TEXT, pages: null, width: null, height: null }, textSel)
        .kind,
    ).toBe('exact');

    const img = imageSelector({ x: 0, y: 0, w: 10, h: 10 }, 100, 100);
    expect(
      resolveAnchor(
        { kind: 'image', text: '', pages: null, width: 100, height: 100 },
        img.kind === 'ok' ? img.selectors : [],
      ).kind,
    ).toBe('rect');
  });

  it('三種成功都算錨得住，只有 not-found 不算', () => {
    expect(anchorOk({ kind: 'exact', start: 0, end: 1, page: null })).toBe(true);
    expect(anchorOk({ kind: 'shifted', start: 0, end: 1, page: null })).toBe(true);
    expect(anchorOk({ kind: 'rect', rect: { x: 0, y: 0, w: 1, h: 1 } })).toBe(true);
    expect(anchorOk({ kind: 'not-found' })).toBe(false);
  });
});
