/**
 * 媒體型別 ↔ `item.kind` ↔ 副檔名。**純函式，零 I/O。**
 *
 * 三個方向都需要：網路抓回來只有 `Content-Type`、本機檔案只有副檔名、
 * 快照要用副檔名存檔（`sources/<sha256>.<ext>`）。
 */

import type { ItemKind } from './state.js';

/**
 * 擷取管線做得出來的四種。**是 `ItemKind` 的子集** ——
 * `paper` 與 `note` 是另外兩條路長出來的（人工分類、點註），
 * 不會從一段位元組推導出來。
 */
export type IngestKind = Extract<ItemKind, 'web' | 'pdf' | 'image' | 'text'>;

/** 支援的型別。**不支援的要列出來，不是靜默略過**（api-contract）。 */
const TABLE: readonly {
  readonly mime: string;
  readonly kind: IngestKind;
  readonly ext: string;
  readonly extras?: readonly string[];
}[] = [
  { mime: 'text/html', kind: 'web', ext: 'html', extras: ['application/xhtml+xml'] },
  { mime: 'application/pdf', kind: 'pdf', ext: 'pdf' },
  { mime: 'text/plain', kind: 'text', ext: 'txt' },
  { mime: 'text/markdown', kind: 'text', ext: 'md' },
  { mime: 'image/png', kind: 'image', ext: 'png' },
  { mime: 'image/jpeg', kind: 'image', ext: 'jpg' },
  { mime: 'image/gif', kind: 'image', ext: 'gif' },
  { mime: 'image/webp', kind: 'image', ext: 'webp' },
  { mime: 'image/avif', kind: 'image', ext: 'avif' },
  { mime: 'image/bmp', kind: 'image', ext: 'bmp' },
];

const BY_EXT: Readonly<Record<string, string>> = {
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  pdf: 'application/pdf',
  txt: 'text/plain',
  text: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
};

/**
 * **`image/svg+xml` 不在支援清單上，而且那是刻意的。**
 *
 * SVG 是一份可以帶 `<script>` 的 XML。快照會被原封不動送回瀏覽器
 * （「看原始快照」），而那時它就不再是一張圖，是一個頁面。
 * 要支援它得先決定怎麼消毒，那是一個獨立的決定 —— 在那之前它是「不支援」，
 * 不是「忘了寫」。
 */
export const DELIBERATELY_UNSUPPORTED: readonly string[] = ['image/svg+xml'];

/** 把 `Content-Type` 標頭切成純 mime（丟掉 `; charset=…`）。 */
export function bareMime(contentType: string | null | undefined): string {
  if (typeof contentType !== 'string') return '';
  const semi = contentType.indexOf(';');
  return (semi < 0 ? contentType : contentType.slice(0, semi)).trim().toLowerCase();
}

/** `Content-Type` 裡的 charset（HTML 解碼要用）。 */
export function charsetOf(contentType: string | null | undefined): string | null {
  if (typeof contentType !== 'string') return null;
  const m = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType);
  return m?.[1]?.toLowerCase() ?? null;
}

export type MediaOutcome =
  | {
      readonly kind: 'ok';
      readonly itemKind: IngestKind;
      readonly mime: string;
      readonly ext: string;
    }
  | { readonly kind: 'unsupported'; readonly mime: string };

export function classifyMime(contentType: string | null | undefined): MediaOutcome {
  const mime = bareMime(contentType);
  for (const row of TABLE) {
    if (row.mime === mime || row.extras?.includes(mime) === true) {
      return { kind: 'ok', itemKind: row.kind, mime: row.mime, ext: row.ext };
    }
  }
  return { kind: 'unsupported', mime };
}

/** 沒有 `Content-Type` 的時候（本機檔案）只能靠副檔名。 */
export function classifyExtension(fileName: string): MediaOutcome {
  const dot = fileName.lastIndexOf('.');
  const ext = dot < 0 ? '' : fileName.slice(dot + 1).toLowerCase();
  const mime = BY_EXT[ext];
  if (mime === undefined) return { kind: 'unsupported', mime: ext };
  return classifyMime(mime);
}

/** 支援的型別清單，給「不支援的型別」訊息用 —— 讓使用者知道什麼可以。 */
export function supportedExtensions(): readonly string[] {
  return Object.keys(BY_EXT);
}
