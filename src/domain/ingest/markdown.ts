/**
 * Markdown 匯入之後**叫什麼名字**（2026-10-28 試用回饋 4 的前半）。
 *
 * 純文字與 Markdown 原本共用一條規則：「第一行去掉開頭的 `#`」。Obsidian 的筆記多半以 YAML
 * frontmatter 開頭，第一行是 `---` —— 試用時匯入 4 份筆記，3 份的標題就叫「---」。
 *
 * Markdown 的規則換成（純文字照舊）：
 *
 * | 順序 | 來源 | 為什麼 |
 * |---|---|---|
 * | 1 | frontmatter 的 `title` | 作者明寫的標題 |
 * | 2 | 正文第一個一級標題（`# …`，略過程式碼區塊）| Markdown 慣例裡它就是文件標題 |
 * | 3 | 檔名（去副檔名，不像預設名的話）| **Obsidian 的筆記名稱就是檔名** —— 比正文第一句更像標題 |
 * | 4 | 正文第一行非空的字（去掉開頭的 `#`）| 原本的規則，留作退路 |
 *
 * frontmatter 只認頂層的 `key: value` 純量（引號會拿掉）；清單、多行字串一律不解析 ——
 * 這裡只要一個標題，不是 YAML 解析器。標題用的是**原文**（含 frontmatter）；v1.1.0 起正文是解析過的
 * `{ text, blocks }`，frontmatter 成為最上面的「文件屬性」那一塊（`infrastructure/extract/markdown.ts`，ADR-0039）。
 */
import { looksLikeDefaultName, stripDocumentExtension } from './title.js';

/** 標題最多幾個字。跟純文字「第一行」那條規則同一個上限。 */
export const MAX_MARKDOWN_TITLE_CHARS = 120;

export interface SplitMarkdown {
  /** frontmatter 頂層的純量欄位；沒有 frontmatter 是 `null` */
  readonly fields: ReadonlyMap<string, string> | null;
  /** frontmatter 之後的正文 */
  readonly body: string;
}

const FENCE = /^\s*(```|~~~)/;
const KEY_VALUE = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/;

function unquote(value: string): string {
  const v = value.trim();
  if (
    v.length >= 2 &&
    ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
  ) {
    return v.slice(1, -1).trim();
  }
  return v;
}

/** frontmatter 在原文裡的位置：兩條 `---` 中間那幾行，與收尾那一行之後（正文）從哪裡開始。 */
export interface FrontmatterSpan {
  readonly contentStart: number;
  readonly contentEnd: number;
  readonly bodyStart: number;
}

/**
 * frontmatter 的位置（v1.1.0 渲染要它，ADR-0039）。規則跟 `splitFrontmatter` 一樣；沒有或沒收尾回 `null`。
 * 位置是**傳進來那個字串**的位置（BOM、`\r\n` 都照算）。
 */
export function frontmatterSpan(text: string): FrontmatterSpan | null {
  const lines: { readonly start: number; readonly end: number; readonly next: number }[] = [];
  let at = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    const nl = text.indexOf('\n', at);
    const end = nl < 0 ? text.length : nl;
    const lineEnd = end > at && text[end - 1] === '\r' ? end - 1 : end;
    lines.push({ start: at, end: lineEnd, next: nl < 0 ? text.length : nl + 1 });
    if (nl < 0) break;
    at = nl + 1;
  }
  const lineText = (i: number): string => {
    const l = lines[i];
    return l === undefined ? '' : text.slice(l.start, l.end).trim();
  };
  if (lineText(0) !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if (lineText(i) !== '---' && lineText(i) !== '...') continue;
    const closing = lines[i] as { readonly start: number; readonly next: number };
    const first = lines[1] as { readonly start: number };
    return { contentStart: first.start, contentEnd: closing.start, bodyStart: closing.next };
  }
  return null;
}

/** 切出 YAML frontmatter：第一行是 `---`，到下一個 `---` 或 `...` 為止。沒收尾就當沒有。 */
export function splitFrontmatter(text: string): SplitMarkdown {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if ((lines[0] ?? '').trim() !== '---') return { fields: null, body: text };
  const end = lines.findIndex(
    (line, i) => i > 0 && (line.trim() === '---' || line.trim() === '...'),
  );
  if (end < 0) return { fields: null, body: text };

  const fields = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const m = KEY_VALUE.exec(line);
    if (m === null) continue;
    const key = (m[1] as string).toLowerCase();
    const value = unquote(m[2] as string);
    // 多行字串（`|`、`>`）與清單不解析 —— 拿到的會是一個符號，不是標題。
    if (value.length === 0 || value === '|' || value === '>' || value.startsWith('[')) continue;
    if (!fields.has(key)) fields.set(key, value);
  }
  return { fields, body: lines.slice(end + 1).join('\n') };
}

/** 正文第一個一級標題（`# …`），略過程式碼區塊裡的 `#`。 */
function firstHeading(body: string): string | null {
  let fenced = false;
  for (const line of body.split('\n')) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m !== null && (m[1] as string).trim().length > 0) return (m[1] as string).trim();
  }
  return null;
}

/** 正文第一行非空的字，去掉開頭的 `#`。 */
function firstLine(body: string): string {
  for (const line of body.split('\n')) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}

/** 這一份 Markdown 在清單、關聯圖、閱讀器上顯示的名字。 */
export function markdownTitle(text: string, fileName: string): string {
  const { fields, body } = splitFrontmatter(text);
  const clip = (s: string): string => s.slice(0, MAX_MARKDOWN_TITLE_CHARS);

  const fromMatter = fields?.get('title') ?? '';
  if (fromMatter.length > 0) return clip(fromMatter);

  const heading = firstHeading(body);
  if (heading !== null) return clip(heading);

  const fromFile = stripDocumentExtension(fileName.trim());
  if (fromFile.length > 0 && !looksLikeDefaultName(fromFile)) return fromFile;

  const line = firstLine(body);
  if (line.length > 0) return clip(line);
  return fromFile.length > 0 ? fromFile : fileName;
}

/** 這一份是不是 Markdown：看型別，型別說不出來再看副檔名。 */
export function isMarkdown(contentType: string | null, name: string): boolean {
  if (contentType !== null && /^text\/(x-)?markdown\b/i.test(contentType.trim())) return true;
  return /\.(md|markdown)$/i.test(name.trim());
}
