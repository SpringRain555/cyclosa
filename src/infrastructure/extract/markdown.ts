/**
 * Markdown → `{ text, blocks, map }`（ADR-0039）。
 *
 * - `text`：畫面上看到的文字。記號拿掉，frontmatter 變成最上面的「文件屬性」那一塊（原樣的幾行）。
 * - `blocks`：結構與位置（`domain/text/markdown-blocks.ts`），**不含任何 HTML 字串**。
 * - `map`：正文第 i 個字在傳進來的原文裡的位置。**不存檔**，只在升級舊資料時把引文與點註換到新正文用。
 *
 * ## 只用 `marked` 的 lexer
 *
 * 不用它產生 HTML（那是 ADR-0039 整份的重點）。Obsidian 的 `[[…]]`、`![[…]]`、`==…==` 用它的擴充介面寫在這裡；
 * 提示框（`> [!note]`）是「第一段以 `[!類型]` 開頭的引用」，在 token 上認。
 *
 * ## 位置怎麼來的
 *
 * marked 的 token 只有 `raw`。**頂層 token 的 `raw` 接起來就是原文**（18.1.1 實測），所以頂層的位置是準的；
 * 往下一層就不是了 —— 引用拿掉了每一行的 `> `、清單拿掉了縮排。所以每一段輸出的字在它那個 token 的範圍裡
 * **依序往後找**（空白對空白），找到的位置就是那個字的位置。找不到的（照理不會發生）記成前一個字的位置，
 * 讓對照表維持非遞減 —— 升級時那一段就換得比較粗，不會換錯方向。
 */
import { Lexer, Marked, type MarkedOptions, type Token, type Tokens } from 'marked';

import { frontmatterSpan } from '../../domain/ingest/markdown.js';
import type {
  MdAlign,
  MdBlock,
  MdInline,
  MdLeaf,
  MdListItem,
} from '../../domain/text/markdown-blocks.js';

export interface ParsedMarkdown {
  readonly text: string;
  readonly blocks: readonly MdBlock[];
  /** `map[i]`：正文第 `i` 個字在原文裡的位置，非遞減。分隔字元記成前一個字的位置 */
  readonly map: Int32Array;
}

/** 區塊之間的分隔。大的蓋過小的：清單結束接著一段，中間是空行不是換行。 */
type Gap = '' | '\t' | '\n' | '\n\n';
const GAP_RANK: Readonly<Record<Gap, number>> = { '': 0, '\t': 1, '\n': 2, '\n\n': 3 };

/** 連結只認這三種（ADR-0039 第三節）。其他的畫成文字。 */
const SAFE_HREF = /^(https?:|mailto:)/i;

export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return SAFE_HREF.test(trimmed) ? trimmed : null;
}

// ── Obsidian 的語法 ─────────────────────────────────────

interface WikiToken {
  readonly type: 'wikilink';
  readonly raw: string;
  readonly text: string;
  readonly target: string;
  readonly embed: boolean;
  /** 有別名時，別名從 `raw` 的第幾個字開始 */
  readonly textAt: number;
}

const WIKI = /^(!?)\[\[([^[\]\n|]+?)(?:\|([^[\]\n]+?))?\]\]/;
const MARK = /^==(?=\S)([^\n]*?\S)==/;

function firstIndex(src: string, needles: readonly string[]): number | undefined {
  let best: number | undefined;
  for (const n of needles) {
    const i = src.indexOf(n);
    if (i >= 0 && (best === undefined || i < best)) best = i;
  }
  return best;
}

const instance = new Marked({ gfm: true });
instance.use({
  extensions: [
    {
      name: 'wikilink',
      level: 'inline',
      start: (src: string) => firstIndex(src, ['![[', '[[']),
      tokenizer(src: string): WikiToken | undefined {
        const m = WIKI.exec(src);
        if (m === null) return undefined;
        const target = (m[2] as string).trim();
        const alias = m[3]?.trim() ?? '';
        return {
          type: 'wikilink',
          raw: m[0],
          text: alias.length > 0 ? alias : target,
          target,
          embed: m[1] === '!',
          textAt: alias.length > 0 ? m[0].indexOf('|') + 1 : 0,
        };
      },
    },
    {
      name: 'mark',
      level: 'inline',
      start: (src: string) => firstIndex(src, ['==']),
      tokenizer(src: string) {
        const m = MARK.exec(src);
        if (m === null) return undefined;
        const text = m[1] as string;
        return { type: 'mark', raw: m[0], text, tokens: this.lexer.inlineTokens(text) };
      },
    },
  ],
});
const OPTIONS: MarkedOptions = instance.defaults;

// ── 輸出 ───────────────────────────────────────────────

class Writer {
  private readonly parts: string[] = [];
  readonly map: number[] = [];
  private pending: Gap = '';
  private last = 0;

  get length(): number {
    return this.map.length;
  }

  /** 下一段之前要隔開多少。真的寫下一段的時候才寫出來（開頭不寫）。 */
  gap(next: Gap): void {
    if (GAP_RANK[next] > GAP_RANK[this.pending]) this.pending = next;
  }

  /** 開始一段：把攢著的分隔寫出來，回這一段的起點。 */
  open(): number {
    if (this.pending !== '' && this.map.length > 0) {
      this.parts.push(this.pending);
      for (let i = 0; i < this.pending.length; i++) this.map.push(this.last);
    }
    this.pending = '';
    return this.map.length;
  }

  put(piece: string, positions: readonly number[]): void {
    this.parts.push(piece);
    for (const p of positions) {
      // 非遞減：找不到的字（照理不會）不讓對照表往回走。
      this.last = Math.max(this.last, p);
      this.map.push(this.last);
    }
  }

  text(): string {
    return this.parts.join('');
  }
}

/** 解析的狀態：原文（只有 `\n`）、輸出，與一個供提示框重新切行內 token 用的 lexer。 */
interface Ctx {
  readonly src: string;
  readonly out: Writer;
  readonly lexer: Lexer;
}

/**
 * `piece` 的每一個字在 `src[from, to)` 裡依序往後找（空白對空白）。回每個字的位置與找完之後的游標。
 */
function align(
  src: string,
  piece: string,
  from: number,
  to: number,
): { readonly at: number[]; readonly next: number } {
  const at: number[] = [];
  let p = from;
  for (let i = 0; i < piece.length; i++) {
    const c = piece[i] as string;
    const space = /\s/.test(c);
    let q = p;
    while (q < to && src[q] !== c && !(space && /\s/.test(src[q] as string))) q++;
    if (q >= to) {
      const fallback = at.length > 0 ? (at[at.length - 1] as number) : Math.min(p, to);
      while (at.length < piece.length) at.push(fallback);
      return { at, next: p };
    }
    at.push(q);
    p = q + 1;
  }
  return { at, next: p };
}

/** 一個 token 在 `src[from, to)` 裡的範圍：`raw` 依序往後找。 */
function locate(ctx: Ctx, raw: string, from: number, to: number): { start: number; end: number } {
  if (raw.length === 0) return { start: from, end: from };
  const found = align(ctx.src, raw, from, to);
  const first = found.at[0] as number;
  const last = found.at[found.at.length - 1] as number;
  return { start: first, end: Math.max(first, last + 1) };
}

function emit(ctx: Ctx, piece: string, from: number, to: number): number {
  if (piece.length === 0) return from;
  const found = align(ctx.src, piece, from, to);
  ctx.out.put(piece, found.at);
  return found.next;
}

// ── 行內 ───────────────────────────────────────────────

type InlineToken = Token | WikiToken;

function inlineTokensOf(token: object): readonly InlineToken[] {
  const tokens = (token as { tokens?: unknown }).tokens;
  return Array.isArray(tokens) ? (tokens as InlineToken[]) : [];
}

/** 一串行內 token 寫進去，標記收進 `marks`。回游標。 */
function inline(
  ctx: Ctx,
  tokens: readonly InlineToken[],
  from: number,
  to: number,
  marks: MdInline[],
): number {
  let cursor = from;
  for (const token of tokens) {
    const raw = (token as { raw?: unknown }).raw;
    const region =
      typeof raw === 'string' ? locate(ctx, raw, cursor, to) : { start: cursor, end: cursor };
    const before = ctx.out.length;
    switch (token.type) {
      case 'text': {
        const children = inlineTokensOf(token);
        if (children.length > 0) inline(ctx, children, region.start, region.end, marks);
        else emit(ctx, (token as Tokens.Text).text, region.start, region.end);
        break;
      }
      case 'escape':
        emit(ctx, (token as Tokens.Escape).text, region.start, region.end);
        break;
      case 'codespan':
        emit(ctx, (token as Tokens.Codespan).text, region.start, region.end);
        marks.push({ kind: 'code', start: before, end: ctx.out.length });
        break;
      case 'br':
        emit(ctx, '\n', region.start, region.end);
        break;
      case 'html':
        emit(ctx, (token as Tokens.HTML).text, region.start, region.end);
        marks.push({ kind: 'html', start: before, end: ctx.out.length });
        break;
      case 'strong':
      case 'em':
      case 'del':
      case 'mark': {
        inline(ctx, inlineTokensOf(token), region.start, region.end, marks);
        marks.push({
          kind: token.type as 'strong' | 'em' | 'del' | 'mark',
          start: before,
          end: ctx.out.length,
        });
        break;
      }
      case 'link': {
        const link = token as Tokens.Link;
        inline(ctx, inlineTokensOf(link), region.start, region.end, marks);
        marks.push({
          kind: 'link',
          start: before,
          end: ctx.out.length,
          href: safeHref(link.href),
          target: link.href,
        });
        break;
      }
      case 'image': {
        const image = token as Tokens.Image;
        // 沒寫替代文字就顯示網址 —— 它也在原文裡，而一張什麼字都沒有的圖在畫面上等於不存在。
        const alt = image.text.trim();
        emit(ctx, alt.length > 0 ? image.text : image.href, region.start, region.end);
        marks.push({ kind: 'image', start: before, end: ctx.out.length, src: image.href });
        break;
      }
      case 'wikilink': {
        const wiki = token as WikiToken;
        emit(ctx, wiki.text, region.start + wiki.textAt, region.end);
        marks.push({
          kind: wiki.embed ? 'embed' : 'wikilink',
          start: before,
          end: ctx.out.length,
          target: wiki.target,
        });
        break;
      }
      default: {
        const text = (token as { text?: unknown }).text;
        if (typeof text === 'string') emit(ctx, text, region.start, region.end);
      }
    }
    cursor = Math.max(cursor, region.end);
  }
  return cursor;
}

/** 一段放文字的（段落、標題、儲存格、提示框標題）。 */
function leaf(ctx: Ctx, tokens: readonly InlineToken[], from: number, to: number): MdLeaf {
  const start = ctx.out.open();
  const marks: MdInline[] = [];
  inline(ctx, tokens, from, to, marks);
  return { start, end: ctx.out.length, inline: marks };
}

/** 一段不切行內的（程式碼、原始 HTML、文件屬性）。 */
function plain(ctx: Ctx, text: string, from: number, to: number): { start: number; end: number } {
  const start = ctx.out.open();
  emit(ctx, text, from, to);
  return { start, end: ctx.out.length };
}

// ── 區塊 ───────────────────────────────────────────────

const ATX = /^ {0,3}#{1,6}(?=[ \t]|$)[ \t]*/;
const LIST_MARKER = /^[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]?/;
const QUOTE_MARKER = /^[ \t]*>[ \t]?/;
const CALLOUT = /^\[!([A-Za-z][\w-]*)\]([+-]?)[ \t]*(.*)$/;

function prefixEnd(ctx: Ctx, pattern: RegExp, from: number, to: number): number {
  const m = pattern.exec(ctx.src.slice(from, to));
  return m === null ? from : from + m[0].length;
}

function blocks(
  ctx: Ctx,
  tokens: readonly Token[],
  from: number,
  to: number,
  sep: Gap,
  exact: boolean,
): MdBlock[] {
  const out: MdBlock[] = [];
  let cursor = from;
  for (const token of tokens) {
    // 頂層：`raw` 接起來就是原文，位置是準的。往下一層才要找。
    const region = exact
      ? { start: cursor, end: cursor + token.raw.length }
      : locate(ctx, token.raw, cursor, to);
    cursor = exact ? region.end : Math.max(cursor, region.end);
    if (token.type === 'space' || token.type === 'def') continue;

    const block = one(ctx, token, region.start, region.end);
    if (block !== null) {
      out.push(block);
      ctx.out.gap(sep);
    }
  }
  return out;
}

function one(ctx: Ctx, token: Token, from: number, to: number): MdBlock | null {
  switch (token.type) {
    case 'heading': {
      const heading = token as Tokens.Heading;
      const level = Math.min(6, Math.max(1, heading.depth)) as 1 | 2 | 3 | 4 | 5 | 6;
      return {
        kind: 'heading',
        level,
        ...leaf(ctx, inlineTokensOf(heading), prefixEnd(ctx, ATX, from, to), to),
      };
    }
    case 'paragraph':
      return { kind: 'paragraph', ...leaf(ctx, inlineTokensOf(token), from, to) };
    case 'text': {
      // 清單裡「緊湊」的項目：區塊層的 text token，底下才是行內 token。
      const children = inlineTokensOf(token);
      const tokens: readonly InlineToken[] =
        children.length > 0
          ? children
          : [
              {
                type: 'text',
                raw: (token as Tokens.Text).text,
                text: (token as Tokens.Text).text,
              } as Tokens.Text,
            ];
      return { kind: 'paragraph', ...leaf(ctx, tokens, from, to) };
    }
    case 'code': {
      const code = token as Tokens.Code;
      // 圍欄式的話跳過第一行（```js），不然程式碼第一個字可能被對到語言名稱上。
      const fenced = /^ {0,3}(```|~~~)/.test(ctx.src.slice(from, to));
      const body = fenced ? Math.min(to, ctx.src.indexOf('\n', from) + 1 || to) : from;
      return { kind: 'code', lang: code.lang?.trim() || null, ...plain(ctx, code.text, body, to) };
    }
    case 'html':
      return {
        kind: 'html',
        ...plain(ctx, (token as Tokens.HTML).text.replace(/\n+$/, ''), from, to),
      };
    case 'hr':
      return { kind: 'hr' };
    case 'blockquote':
      return quote(ctx, token as Tokens.Blockquote, from, to);
    case 'list':
      return list(ctx, token as Tokens.List, from, to);
    case 'table':
      return table(ctx, token as Tokens.Table, from, to);
    default: {
      const text = (token as { text?: unknown }).text;
      if (typeof text !== 'string' || text.trim().length === 0) return null;
      return {
        kind: 'paragraph',
        ...leaf(ctx, [{ type: 'text', raw: text, text } as Tokens.Text], from, to),
      };
    }
  }
}

function quote(ctx: Ctx, token: Tokens.Blockquote, from: number, to: number): MdBlock {
  const inner = prefixEnd(ctx, QUOTE_MARKER, from, to);
  const first = token.tokens[0];
  if (first?.type === 'paragraph') {
    const text = (first as Tokens.Paragraph).text;
    const nl = text.indexOf('\n');
    const m = CALLOUT.exec(nl < 0 ? text : text.slice(0, nl));
    if (m !== null) {
      const head = locate(ctx, first.raw, inner, to);
      const titleText = (m[3] as string).trim();
      const marker = locate(ctx, `[!${m[1] as string}]${m[2] as string}`, head.start, head.end);
      const title =
        titleText.length > 0
          ? leaf(ctx, ctx.lexer.inlineTokens(titleText), marker.end, head.end)
          : null;
      ctx.out.gap('\n');
      const children: MdBlock[] = [];
      const rest = nl < 0 ? '' : text.slice(nl + 1);
      if (rest.trim().length > 0) {
        const restAt =
          title === null ? marker.end : Math.max(marker.end, ctx.src.indexOf('\n', marker.end) + 1);
        children.push({
          kind: 'paragraph',
          ...leaf(ctx, ctx.lexer.inlineTokens(rest), restAt, head.end),
        });
        ctx.out.gap('\n\n');
      }
      children.push(...blocks(ctx, token.tokens.slice(1), head.end, to, '\n\n', false));
      return {
        kind: 'callout',
        callout: (m[1] as string).toLowerCase(),
        fold: m[2] === '+' || m[2] === '-' ? m[2] : null,
        title,
        children,
      };
    }
  }
  return { kind: 'quote', children: blocks(ctx, token.tokens, inner, to, '\n\n', false) };
}

function list(ctx: Ctx, token: Tokens.List, from: number, to: number): MdBlock {
  const items: MdListItem[] = [];
  let cursor = from;
  for (const item of token.items) {
    const region = locate(ctx, item.raw, cursor, to);
    cursor = Math.max(cursor, region.end);
    const body = prefixEnd(ctx, LIST_MARKER, region.start, region.end);
    const children = item.tokens.filter((t) => t.type !== 'checkbox');
    // 待辦的方框（`[ ] `）不是文字：從它後面開始找。
    const after = item.task ? locate(ctx, '] ', body, region.end).end : body;
    ctx.out.gap('\n');
    items.push({
      task: item.task,
      checked: item.checked === true,
      children: blocks(ctx, children, after, region.end, '\n', false),
    });
  }
  const first = typeof token.start === 'number' ? token.start : null;
  return { kind: 'list', ordered: token.ordered, first: token.ordered ? first : null, items };
}

function table(ctx: Ctx, token: Tokens.Table, from: number, to: number): MdBlock {
  // 一列一行：表頭、分隔線、資料列。儲存格在自己那一行裡依序找。
  const lines: { start: number; end: number }[] = [];
  let at = from;
  while (at < to) {
    const nl = ctx.src.indexOf('\n', at);
    const end = nl < 0 || nl > to ? to : nl;
    lines.push({ start: at, end });
    at = end + 1;
  }
  const row = (
    cells: readonly Tokens.TableCell[],
    line: { start: number; end: number } | undefined,
  ): MdLeaf[] => {
    let cursor = line?.start ?? to;
    const end = line?.end ?? to;
    return cells.map((cell, i) => {
      if (i > 0) ctx.out.gap('\t');
      const region =
        cell.text.length > 0 ? locate(ctx, cell.text, cursor, end) : { start: cursor, end: cursor };
      cursor = Math.max(cursor, region.end);
      return leaf(ctx, cell.tokens, region.start, region.end);
    });
  };
  const head = row(token.header, lines[0]);
  const rows = token.rows.map((cells, r) => {
    ctx.out.gap('\n');
    return row(cells, lines[r + 2]);
  });
  const align: MdAlign[] = token.align.map((a) => a ?? null);
  return { kind: 'table', align, head, rows };
}

// ── 入口 ───────────────────────────────────────────────

/** `\r\n` 與單獨的 `\r` 換成 `\n`，並記下每個字在原文的位置。 */
function normalize(source: string): { readonly src: string; readonly at: Int32Array | null } {
  if (!source.includes('\r')) return { src: source, at: null };
  const chars: string[] = [];
  const at: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const c = source[i] as string;
    if (c === '\r') {
      if (source[i + 1] === '\n') continue;
      chars.push('\n');
    } else {
      chars.push(c);
    }
    at.push(i);
  }
  at.push(source.length);
  return { src: chars.join(''), at: Int32Array.from(at) };
}

export function parseMarkdown(source: string): ParsedMarkdown {
  const { src, at } = normalize(source);
  const ctx: Ctx = { src, out: new Writer(), lexer: new Lexer(OPTIONS) };
  const out: MdBlock[] = [];

  let bodyStart = 0;
  const matter = frontmatterSpan(src);
  if (matter !== null) {
    bodyStart = matter.bodyStart;
    const content = src.slice(matter.contentStart, matter.contentEnd).replace(/\s+$/, '');
    if (content.trim().length > 0) {
      out.push({
        kind: 'frontmatter',
        ...plain(ctx, content, matter.contentStart, matter.contentEnd),
      });
      ctx.out.gap('\n\n');
    }
  }

  const body = src.slice(bodyStart);
  out.push(...blocks(ctx, instance.lexer(body), bodyStart, src.length, '\n\n', true));

  const map = Int32Array.from(ctx.out.map);
  if (at !== null) for (let i = 0; i < map.length; i++) map[i] = at[map[i] as number] as number;
  return { text: ctx.out.text(), blocks: out, map };
}
