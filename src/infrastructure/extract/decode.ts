/**
 * 位元組 → 字串。
 *
 * **快照存的是原始位元組**（ADR-0003），所以每次要讀它都得重新解碼一次 ——
 * 解碼規則寫在這裡，而不是散在每個呼叫端。
 */

/** `<meta charset>` 只掃前面這麼多位元組。規格說它必須出現在前 1024 個。 */
const META_SCAN_BYTES = 2048;

export type DecodeOutcome =
  | { readonly kind: 'ok'; readonly text: string; readonly charset: string }
  /** 標籤不認得（`TextDecoder` 不支援）—— `PARSE_ENCODING`。 */
  | { readonly kind: 'unknown-charset'; readonly charset: string };

function sniffMetaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, META_SCAN_BYTES)).toString('latin1');
  const m1 = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head);
  if (m1?.[1] !== undefined) return m1[1].toLowerCase();
  const m2 = /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)["']/i.exec(head);
  return m2?.[1]?.toLowerCase() ?? null;
}

/**
 * 依序試：`Content-Type` 的 charset → 文件裡的 `<meta charset>` → UTF-8。
 *
 * **順序是規格定的**（HTML Standard 的 encoding sniffing），
 * 而它容易被寫反 —— 文件內的宣告比 HTTP 標頭更常被人記得，但它的優先度較低。
 */
export function decodeHtml(bytes: Uint8Array, headerCharset: string | null): DecodeOutcome {
  const candidates = [headerCharset, sniffMetaCharset(bytes), 'utf-8'];
  for (const label of candidates) {
    if (label === null || label.length === 0) continue;
    try {
      const text = new TextDecoder(label, { fatal: false }).decode(bytes);
      return { kind: 'ok', text, charset: label };
    } catch {
      // 這個標籤不認得，試下一個。**最後一個是 utf-8，它永遠認得** ——
      // 所以只有「標頭與 meta 都寫了怪東西」時才會走到下面那行。
      if (label === 'utf-8') return { kind: 'unknown-charset', charset: label };
    }
  }
  return { kind: 'unknown-charset', charset: headerCharset ?? '' };
}

/** 純文字／Markdown。沒有 `<meta>` 可以問，只能靠標頭與 UTF-8。 */
export function decodeText(bytes: Uint8Array, headerCharset: string | null): DecodeOutcome {
  const label = headerCharset ?? 'utf-8';
  try {
    return {
      kind: 'ok',
      text: new TextDecoder(label, { fatal: false }).decode(bytes),
      charset: label,
    };
  } catch {
    return { kind: 'unknown-charset', charset: label };
  }
}
