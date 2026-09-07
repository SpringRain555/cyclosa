/**
 * 圖片的登記：只讀尺寸，**不產生縮圖**。
 *
 * > **為什麼沒有縮圖。** 產縮圖要一個影像處理套件，而在 Node 上那些
 * > 全部是原生模組（`sharp`、`canvas`）—— 與「零原生模組、一鍵啟動」
 * > 直接衝突（ADR-0002）。閱讀器與清單改用 CSS 縮放原圖：
 * > **多花的是頻寬，而這是一個 `127.0.0.1` 的單機工具，那條頻寬是記憶體複製。**
 * >
 * > 重新考慮的觸發條件：真實資料裡出現大量超過 10 MB 的圖，
 * > 而清單頁因此變慢 —— 那時要量的是清單頁的時間，不是圖的大小。
 *
 * 尺寸是**矩形註記的座標系**（ADR-0019 的 `#xywh=pixel:`），
 * 所以讀不出來要說讀不出來，不要給一個猜的數字。
 */

export interface ImageInfo {
  readonly width: number;
  readonly height: number;
}

function u16be(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) << 8) | (b[o + 1] ?? 0);
}
function u32be(b: Uint8Array, o: number): number {
  return (
    (((b[o] ?? 0) << 24) >>> 0) + ((b[o + 1] ?? 0) << 16) + ((b[o + 2] ?? 0) << 8) + (b[o + 3] ?? 0)
  );
}
function u16le(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}
function u32le(b: Uint8Array, o: number): number {
  return (
    ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0
  );
}

/**
 * 從位元組讀寬高。**認不出來回 `null`** ——
 * AVIF 走的是 ISOBMFF 容器，要解析 box 樹才拿得到尺寸，
 * 第一版不做（圖還是顯示得出來，只是矩形註記要等尺寸）。
 */
export function imageDimensions(bytes: Uint8Array): ImageInfo | null {
  // PNG: 8 byte signature + IHDR
  if (
    bytes.length > 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }

  // GIF: 'GIF8' + 2 byte LE width/height
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: u16le(bytes, 6), height: u16le(bytes, 8) };
  }

  // BMP
  if (bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { width: u32le(bytes, 18), height: Math.abs(u32le(bytes, 22) | 0) };
  }

  // WEBP: RIFF....WEBP
  if (bytes.length > 30 && bytes[0] === 0x52 && bytes[8] === 0x57 && bytes[9] === 0x45) {
    const fourcc = String.fromCharCode(
      bytes[12] ?? 0,
      bytes[13] ?? 0,
      bytes[14] ?? 0,
      bytes[15] ?? 0,
    );
    if (fourcc === 'VP8 ')
      return { width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    if (fourcc === 'VP8L') {
      const bits = u32le(bytes, 21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fourcc === 'VP8X') {
      const w = ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16)) + 1;
      const h = ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16)) + 1;
      return { width: w, height: h };
    }
    return null;
  }

  // JPEG: 掃 SOF0–SOF15（跳過 SOF4／SOF8／SOF12，那些不是 frame header）
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1] ?? 0;
      const length = u16be(bytes, offset + 2);
      const isSof =
        marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
      if (length <= 0) break;
      offset += 2 + length;
    }
    return null;
  }

  return null;
}
