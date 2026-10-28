/**
 * Markdown → `{ text, blocks, map }`（ADR-0039）。
 *
 * 每一種語法釘三件事：**正文是畫面上看到的字**（記號拿掉）、**結構對**、**位置對照表指回原文的同一個字**。
 * 第三件是升級舊資料時換引文與點註的依據 —— 它錯了，換過去的引文就會偏一格。
 */
import { describe, expect, it } from 'vitest';

import { checkBlocks, leavesOf, type MdBlock } from '../../src/domain/text/markdown-blocks.js';
import { parseMarkdown, safeHref } from '../../src/infrastructure/extract/markdown.js';

/** 每一段裡的每一個字，都要在對照表指到的原文位置上（空白對空白）。 */
function mapIsExact(source: string, parsed: ReturnType<typeof parseMarkdown>): void {
  expect(parsed.map.length).toBe(parsed.text.length);
  for (let i = 1; i < parsed.map.length; i++) {
    expect(parsed.map[i]).toBeGreaterThanOrEqual(parsed.map[i - 1] as number);
  }
  for (const leaf of leavesOf(parsed.blocks)) {
    for (let i = leaf.start; i < leaf.end; i++) {
      const shown = parsed.text[i] as string;
      const original = source[parsed.map[i] as number] as string;
      if (/\s/.test(shown)) expect(original).toMatch(/\s/);
      else expect(original).toBe(shown);
    }
  }
}

function parse(source: string): ReturnType<typeof parseMarkdown> {
  const parsed = parseMarkdown(source);
  expect(checkBlocks(parsed.text, parsed.blocks)).toBeNull();
  mapIsExact(source, parsed);
  return parsed;
}

function slice(text: string, span: { start: number; end: number }): string {
  return text.slice(span.start, span.end);
}

describe('區塊', () => {
  it('標題與段落：記號拿掉，區塊之間空一行', () => {
    const p = parse('# 一級 **粗**\n\n段落第一行\n第二行\n\n### 三級');
    expect(p.text).toBe('一級 粗\n\n段落第一行\n第二行\n\n三級');
    const [h1, para, h3] = p.blocks as [MdBlock, MdBlock, MdBlock];
    expect(h1).toMatchObject({ kind: 'heading', level: 1 });
    expect(para).toMatchObject({ kind: 'paragraph' });
    expect(slice(p.text, para as { start: number; end: number })).toBe('段落第一行\n第二行');
    expect(h3).toMatchObject({ kind: 'heading', level: 3 });
  });

  it('frontmatter 變成最上面的「文件屬性」，原樣幾行、不含 ---', () => {
    const p = parse('---\ntitle: 筆記\ntags: [a, b]\n---\n\n正文。');
    expect(p.blocks[0]).toMatchObject({ kind: 'frontmatter' });
    expect(slice(p.text, p.blocks[0] as { start: number; end: number })).toBe(
      'title: 筆記\ntags: [a, b]',
    );
    expect(p.text.endsWith('正文。')).toBe(true);
  });

  it('空的 frontmatter 不留一塊空的', () => {
    const p = parse('---\n---\n正文。');
    expect(p.blocks.map((b) => b.kind)).toEqual(['paragraph']);
    expect(p.text).toBe('正文。');
  });

  it('清單：有序的起始編號、巢狀、待辦的勾選；符號不在正文裡', () => {
    const p = parse('3. 三\n4. 四\n\n- 甲\n- [ ] 乙\n  - 巢狀\n- [x] 丙');
    expect(p.text).toBe('三\n四\n\n甲\n乙\n巢狀\n丙');
    const [ordered, plain] = p.blocks as [MdBlock, MdBlock];
    expect(ordered).toMatchObject({ kind: 'list', ordered: true, first: 3 });
    expect(plain).toMatchObject({ kind: 'list', ordered: false, first: null });
    if (plain.kind !== 'list') throw new Error('不是清單');
    expect(plain.items.map((i) => [i.task, i.checked])).toEqual([
      [false, false],
      [true, false],
      [true, true],
    ]);
    expect(plain.items[1]?.children.map((b) => b.kind)).toEqual(['paragraph', 'list']);
  });

  it('引用與提示框：提示框的類型、收合記號與標題分開記', () => {
    const p = parse('> 一般\n> 第二行\n\n> [!WARNING]- 小心\n> 內文\n\n> [!tip]\n> 只有內文');
    expect(p.text).toBe('一般\n第二行\n\n小心\n內文\n\n只有內文');
    const [q, warn, tip] = p.blocks as [MdBlock, MdBlock, MdBlock];
    expect(q.kind).toBe('quote');
    expect(warn).toMatchObject({ kind: 'callout', callout: 'warning', fold: '-' });
    if (warn.kind !== 'callout' || warn.title === null) throw new Error('沒有標題');
    expect(slice(p.text, warn.title)).toBe('小心');
    expect(tip).toMatchObject({ kind: 'callout', callout: 'tip', fold: null, title: null });
  });

  it('表格：儲存格之間是 tab、列之間換行；對齊照原文', () => {
    const p = parse('| 名 | 值 |\n|:--|--:|\n| a | **1** |\n| b | |');
    expect(p.text).toBe('名\t值\na\t1\nb\t');
    expect(p.blocks[0]).toMatchObject({ kind: 'table', align: ['left', 'right'] });
  });

  it('程式碼區塊照原文，語言另記；第一個字不會被對到語言名稱上', () => {
    const source = '```js\njs();\n```';
    const p = parse(source);
    expect(p.text).toBe('js();');
    expect(p.blocks[0]).toMatchObject({ kind: 'code', lang: 'js' });
    expect(p.map[0]).toBe(source.indexOf('js();'));
  });

  it('原始 HTML 區塊當文字；分隔線沒有字', () => {
    const p = parse('<div onclick="x()">嗨</div>\n\n---\n\n尾');
    expect(p.text).toBe('<div onclick="x()">嗨</div>\n\n尾');
    expect(p.blocks.map((b) => b.kind)).toEqual(['html', 'hr', 'paragraph']);
  });

  it('連結的參考定義不顯示', () => {
    const p = parse('看[這裡][r]。\n\n[r]: https://example.org');
    expect(p.text).toBe('看這裡。');
  });
});

describe('行內', () => {
  it('粗體、斜體、刪除線、標記、行內程式碼：字留著、記號拿掉', () => {
    const p = parse('**粗** *斜* ~~刪~~ ==標== `碼`');
    expect(p.text).toBe('粗 斜 刪 標 碼');
    const para = p.blocks[0];
    if (para?.kind !== 'paragraph') throw new Error('不是段落');
    expect(para.inline.map((m) => [m.kind, slice(p.text, m)])).toEqual([
      ['strong', '粗'],
      ['em', '斜'],
      ['del', '刪'],
      ['mark', '標'],
      ['code', '碼'],
    ]);
  });

  it('wiki 連結顯示別名或名稱；嵌入顯示名稱', () => {
    const p = parse('[[筆記]] [[目標#段|別名]] ![[圖.png]]');
    expect(p.text).toBe('筆記 別名 圖.png');
    const para = p.blocks[0];
    if (para?.kind !== 'paragraph') throw new Error('不是段落');
    expect(para.inline).toMatchObject([
      { kind: 'wikilink', target: '筆記' },
      { kind: 'wikilink', target: '目標#段' },
      { kind: 'embed', target: '圖.png' },
    ]);
  });

  it('別名的位置指在別名上，不會被目標名稱裡的同一個字搶走', () => {
    const source = '[[ab|b]]';
    const p = parse(source);
    expect(p.text).toBe('b');
    expect(p.map[0]).toBe(source.lastIndexOf('b'));
  });

  it('連結只認 http／https／mailto；其他的 href 是 null', () => {
    const p = parse(
      '[好](https://a.example) [信](mailto:x@y.z) [壞](javascript:alert(1)) [相對](./x.md)',
    );
    const para = p.blocks[0];
    if (para?.kind !== 'paragraph') throw new Error('不是段落');
    expect(para.inline.map((m) => (m.kind === 'link' ? m.href : 'x'))).toEqual([
      'https://a.example',
      'mailto:x@y.z',
      null,
      null,
    ]);
    expect(safeHref('  HTTPS://A.example ')).toBe('HTTPS://A.example');
    expect(safeHref('java\tscript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
  });

  it('圖片只記網址、正文是替代文字；沒有替代文字就用網址', () => {
    const p = parse('![示意圖](https://a.example/x.png) ![](https://a.example/y.png)');
    expect(p.text).toBe('示意圖 https://a.example/y.png');
    const para = p.blocks[0];
    if (para?.kind !== 'paragraph') throw new Error('不是段落');
    expect(para.inline).toMatchObject([
      { kind: 'image', src: 'https://a.example/x.png' },
      { kind: 'image', src: 'https://a.example/y.png' },
    ]);
  });

  it('跳脫與行內 HTML：跳脫拿掉反斜線，HTML 照原文、標成 html', () => {
    const p = parse('\\*不是斜體\\* <b>粗</b> &amp;');
    expect(p.text).toBe('*不是斜體* <b>粗</b> &amp;');
    const para = p.blocks[0];
    if (para?.kind !== 'paragraph') throw new Error('不是段落');
    expect(para.inline.filter((m) => m.kind === 'html').map((m) => slice(p.text, m))).toEqual([
      '<b>',
      '</b>',
    ]);
  });
});

describe('位置對照表', () => {
  it('\\r\\n 的原文：對照表指回原文（含 \\r 的位置）', () => {
    const source = '# 標題\r\n\r\n> 引用\r\n> 第二行';
    const p = parse(source);
    expect(p.text).toBe('標題\n\n引用\n第二行');
    expect(p.map[p.text.indexOf('第')]).toBe(source.indexOf('第'));
  });

  it('引用與清單的縮排、前綴不會讓位置偏掉', () => {
    const source = '> 甲\n> > 乙\n\n- 一\n\n  續\n\t- 二';
    parse(source);
  });

  it('一份像 Obsidian 筆記的混合內容：不變式與對照表都成立', () => {
    const source = [
      '---',
      'tags: [研究]',
      '---',
      '# 會議紀錄',
      '',
      '討論 [[專案甲|甲案]] 的 ==時程==，參考 [規格](https://example.org/spec)。',
      '',
      '> [!note] 決議',
      '> 下週二前交 **初稿**',
      '',
      '- [x] 寄信',
      '- [ ] 訂會議室',
      '    1. 三樓',
      '',
      '| 項目 | 負責 |',
      '|---|---|',
      '| 初稿 | 甲 |',
      '',
      '```',
      'code',
      '```',
    ].join('\n');
    const p = parse(source);
    expect(p.text).toContain('討論 甲案 的 時程，參考 規格。');
  });
});
