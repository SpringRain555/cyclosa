/**
 * Markdown 結構的不變式與位置換算（ADR-0039）。
 */
import { describe, expect, it } from 'vitest';

import {
  checkBlocks,
  prose,
  remapRange,
  type MdBlock,
} from '../../src/domain/text/markdown-blocks.js';

const para = (start: number, end: number): MdBlock => ({
  kind: 'paragraph',
  start,
  end,
  inline: [],
});

describe('checkBlocks', () => {
  it('照順序、不重疊、字都在某一段裡：成立', () => {
    expect(checkBlocks('甲\n\n乙', [para(0, 1), para(3, 4)])).toBeNull();
  });

  it('重疊或倒序', () => {
    expect(checkBlocks('甲乙丙', [para(0, 2), para(1, 3)])).toMatch(/重疊或倒序/);
  });

  it('超出正文', () => {
    expect(checkBlocks('甲', [para(0, 5)])).toMatch(/超出正文/);
  });

  it('**看得到的字不在任何一段裡** —— 搜得到、畫面上卻沒有', () => {
    expect(checkBlocks('甲\n漏\n乙', [para(0, 1), para(4, 5)])).toMatch(/不在任何片段裡/);
    expect(checkBlocks('甲 尾', [para(0, 1)])).toMatch(/不在任何片段裡/);
  });

  it('行內片段要在所屬那一段裡', () => {
    const bad: MdBlock = {
      kind: 'paragraph',
      start: 0,
      end: 2,
      inline: [{ kind: 'strong', start: 1, end: 3 }],
    };
    expect(checkBlocks('甲乙丙', [bad, para(2, 3)])).toMatch(/行內片段/);
  });

  it('容器（清單、引用、表格）裡的片段一起算', () => {
    const blocks: MdBlock[] = [
      {
        kind: 'list',
        ordered: false,
        first: null,
        items: [{ task: false, checked: false, children: [para(0, 1)] }],
      },
      { kind: 'quote', children: [para(3, 4)] },
      {
        kind: 'table',
        align: [null],
        head: [{ start: 6, end: 7, inline: [] }],
        rows: [[{ start: 8, end: 9, inline: [] }]],
      },
    ];
    expect(checkBlocks('一\n\n二\n\n頭\n格', blocks)).toBeNull();
  });
});

describe('remapRange：原文的一段換到新正文', () => {
  // 原文「**重點**的話」→ 新正文「重點的話」：新正文第 i 個字在原文的位置。
  const map = [2, 3, 6, 7];
  const text = '重點的話';

  it('包著記號的那一段，換成記號拿掉之後的字', () => {
    expect(remapRange(map, text, 0, 8)).toEqual({ start: 0, end: 4 });
    expect(remapRange(map, text, 0, 6)).toEqual({ start: 0, end: 2 });
  });

  it('只框到記號（一個字都沒有）：對不上，回 null', () => {
    expect(remapRange(map, text, 0, 2)).toBeNull();
    expect(remapRange(map, text, 4, 6)).toBeNull();
  });

  it('頭尾的分隔空白去掉', () => {
    // 新正文「甲\n\n乙」，分隔的兩個換行記成前一個字的位置。
    expect(remapRange([0, 0, 0, 3], '甲\n\n乙', 0, 4)).toEqual({ start: 0, end: 4 });
    expect(remapRange([0, 0, 0, 3], '甲\n\n乙', 1, 4)).toEqual({ start: 3, end: 4 });
  });
});

describe('prose：語言偵測跳過文件屬性', () => {
  it('第一塊是 frontmatter 就從它後面開始', () => {
    const blocks: MdBlock[] = [{ kind: 'frontmatter', start: 0, end: 9 }, para(11, 13)];
    expect(prose('tags: [x]\n\n中文', blocks)).toBe('中文');
  });

  it('沒有 frontmatter 或不是 Markdown：整份', () => {
    expect(prose('全文', [para(0, 2)])).toBe('全文');
    expect(prose('全文', null)).toBe('全文');
  });
});
