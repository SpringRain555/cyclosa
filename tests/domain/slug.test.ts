import { describe, expect, it } from 'vitest';
import { isUsableSlug, toSlug } from '../../src/domain/case/slug.js';

describe('專題名稱 → 資料夾名稱', () => {
  it('**中文保留原樣** —— 使用者要在檔案總管裡認得出自己的專題', () => {
    expect(toSlug('蓬萊塵蛛的網上裝飾行為')).toBe('蓬萊塵蛛的網上裝飾行為');
  });

  it('空白收斂成連字號', () => {
    expect(toSlug('taiwan  spider   study')).toBe('taiwan-spider-study');
  });

  it('拿掉 Windows 檔名不能用的字元', () => {
    expect(toSlug('a<b>c:d"e/f\\g|h?i*j')).toBe('abcdefghij');
  });

  it('結尾的點與空白不會留下 —— Windows 會靜默吃掉它們', () => {
    expect(toSlug('我的專題.')).toBe('我的專題');
    expect(toSlug('我的專題   ')).toBe('我的專題');
    expect(toSlug('..a..')).toBe('a');
  });

  it('保留裝置名會被改掉 —— 那些名字建不出資料夾', () => {
    for (const n of ['CON', 'con', 'PRN', 'com1', 'LPT9']) {
      expect(toSlug(n)).toBe(`${n}-case`);
    }
  });

  it('太長會被截斷，而且截斷後不會留下結尾連字號', () => {
    const s = toSlug('a '.repeat(200));
    expect(s.length).toBeLessThanOrEqual(60);
    expect(s.endsWith('-')).toBe(false);
  });

  it('**toSlug 的產出一定過得了 isUsableSlug**', () => {
    const inputs = [
      '蓬萊塵蛛',
      'taiwan spider',
      'a.b',
      'a<b>c',
      '  spaced  out  ',
      'CON',
      'x'.repeat(200),
      '2026-09 專題',
    ];
    for (const input of inputs) {
      const slug = toSlug(input);
      expect(isUsableSlug(slug), `${input} -> ${slug}`).toBe(true);
    }
  });

  it('全部是非法字元時產出空字串（呼叫端要擋）', () => {
    expect(toSlug('<<>>')).toBe('');
    expect(isUsableSlug('')).toBe(false);
  });
});
