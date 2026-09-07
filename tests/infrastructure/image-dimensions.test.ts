import { describe, expect, it } from 'vitest';
import { imageDimensions } from '../../src/infrastructure/extract/image.js';

/**
 * 尺寸是**矩形註記的座標系**（ADR-0019 的 `#xywh=pixel:`）——
 * 讀不出來要回 `null`，不是猜一個數字。
 */
describe('圖片尺寸', () => {
  it('PNG', () => {
    // 1×1 的透明 PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    expect(imageDimensions(new Uint8Array(png))).toEqual({ width: 1, height: 1 });
  });

  it('GIF', () => {
    const gif = Buffer.from('R0lGODdhCgAFAIAAAAAAAP///ywAAAAACgAFAAACB4SPqcvtDwUAOw==', 'base64');
    expect(imageDimensions(new Uint8Array(gif))).toEqual({ width: 10, height: 5 });
  });

  it('JPEG', () => {
    // 最小的 JPEG 骨架：SOI ＋ 一段 APP0 ＋ SOF0（8×16）
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10,
      0x00, 0x08, 0x03,
    ]);
    expect(imageDimensions(bytes)).toEqual({ width: 8, height: 16 });
  });

  it('**認不出來就回 null**，不要猜', () => {
    expect(imageDimensions(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(imageDimensions(new Uint8Array(0))).toBeNull();
  });
});
