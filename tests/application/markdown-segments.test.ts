/**
 * 閱讀器把一段 Markdown 切成片段（ADR-0039 第二節）。**片段的字接起來就是那一段** ——
 * 選取換算數的是文字節點，多一個字、少一個字都會讓點註存到別的位置。
 */
import { describe, expect, it } from 'vitest';

import { safeHref, segmentLeaf } from '../../web/src/components/markdown-segments.js';

const TEXT = '前言粗體斜體連結尾巴';
// 「粗體斜體」是粗體，裡面的「斜體」再加斜體；「連結」是連結。
const LEAF = {
  start: 2,
  end: 10,
  inline: [
    { kind: 'strong' as const, start: 2, end: 6 },
    { kind: 'em' as const, start: 4, end: 6 },
    {
      kind: 'link' as const,
      start: 6,
      end: 8,
      href: 'https://a.example',
      target: 'https://a.example',
    },
  ],
};

describe('segmentLeaf', () => {
  it('片段接起來就是那一段，一字不多', () => {
    const segments = segmentLeaf(TEXT, LEAF, []);
    expect(segments.map((s) => s.text).join('')).toBe(TEXT.slice(2, 10));
  });

  it('樣式由外而內：粗體包著斜體', () => {
    const segments = segmentLeaf(TEXT, LEAF, []);
    expect(segments.map((s) => [s.text, s.marks.map((m) => m.kind)])).toEqual([
      ['粗體', ['strong']],
      ['斜體', ['strong', 'em']],
      ['連結', ['link']],
      ['尾巴', []],
    ]);
  });

  it('點註跨過樣式的邊界：在邊界上切開，每一片都標同一則', () => {
    const segments = segmentLeaf(TEXT, LEAF, [{ id: 'n1', start: 3, end: 7 }]);
    expect(segments.map((s) => [s.text, s.noteId])).toEqual([
      ['粗', null],
      ['體', 'n1'],
      ['斜體', 'n1'],
      ['連', 'n1'],
      ['結', null],
      ['尾巴', null],
    ]);
  });

  it('不在這一段的點註不影響；跨出這一段的切在段的邊界', () => {
    const segments = segmentLeaf(TEXT, { start: 2, end: 4, inline: [] }, [
      { id: 'far', start: 8, end: 10 },
      { id: 'wide', start: 0, end: 3 },
    ]);
    expect(segments.map((s) => [s.text, s.noteId])).toEqual([
      ['粗', 'wide'],
      ['體', null],
    ]);
  });
});

describe('safeHref', () => {
  it('只認 http／https／mailto', () => {
    expect(safeHref('https://a.example')).toBe('https://a.example');
    expect(safeHref(' mailto:x@y.z ')).toBe('mailto:x@y.z');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,x')).toBeNull();
    expect(safeHref('./a.md')).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});
