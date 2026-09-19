/**
 * pdf.js 在瀏覽器這一邊的載入點（v0.24.1，閱讀器的「版面」檢視）。
 *
 * **動態載入**：這個套件不小（主程式加 worker 將近 2 MB），而大部分的頁面用不到它 ——
 * 只有打開一份 PDF 的版面檢視時才載進來，載一次之後共用。
 *
 * worker 是 Vite 當成靜態檔輸出的 `.mjs`（`?url`），以 module worker 執行；
 * 伺服器給 `.mjs` 的 MIME 是 JavaScript（`interface/http/static.ts`），不然瀏覽器拒絕執行。
 */
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

export type Pdfjs = typeof import('pdfjs-dist');

let loading: Promise<Pdfjs> | null = null;

export function loadPdfjs(): Promise<Pdfjs> {
  loading ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
    return pdfjs;
  });
  return loading;
}

/**
 * pdf.js 另外要的資料檔：中日韓的 CMap、沒內嵌的標準字型、解 JPEG 2000／JBIG2 的 wasm、
 * 色彩描述檔。**伺服器從裝好的 `pdfjs-dist` 直接給**（`/pdfjs/<資料夾>/`），
 * 所以版本永遠跟這裡打包的 pdf.js 一致。少了它們的症狀是安靜的：字變空白、圖變一塊空白。
 */
export function pdfjsAssetOptions(): {
  cMapUrl: string;
  cMapPacked: boolean;
  standardFontDataUrl: string;
  wasmUrl: string;
  iccUrl: string;
} {
  const base = new URL('/pdfjs/', window.location.href).href;
  return {
    cMapUrl: `${base}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${base}standard_fonts/`,
    wasmUrl: `${base}wasm/`,
    iccUrl: `${base}iccs/`,
  };
}
