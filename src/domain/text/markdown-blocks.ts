/**
 * Markdown 的結構（ADR-0039）。**只有位置，沒有任何 HTML 字串。**
 *
 * 伺服器把 Markdown 解析成 `{ text, blocks }`：`text` 是畫面上看到的文字（檢索、抽取、引文、點註都錨在它上面），
 * `blocks` 說哪一段是標題、哪一段是清單。每一個片段都是 `text` 的一段 `[start, end)`。
 * **區塊之間的分隔字元（空行、清單與表格的換行、儲存格的 tab）不屬於任何片段** —— 閱讀器不畫它們。
 *
 * 只有「放文字的那一層」（`MdLeaf` 與文件屬性、程式碼、原始 HTML）有位置；清單、引用、提示框、表格是容器。
 * 閱讀器只在那一層的元素上放 `data-start`，選取換算（`offsetWithin`）才會一字不差。
 */

export type MdInline =
  | {
      readonly kind: 'strong' | 'em' | 'del' | 'mark' | 'code' | 'html';
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly kind: 'link';
      readonly start: number;
      readonly end: number;
      /** **只有 http／https／mailto 才有值**；其他（`javascript:`、相對路徑）是 `null`，畫成文字 */
      readonly href: string | null;
      /** 原文寫的網址，給提示看 */
      readonly target: string;
    }
  | {
      /** `[[a]]`、`[[a|b]]` 與 `![[a]]`。正文是別名或目標名稱 */
      readonly kind: 'wikilink' | 'embed';
      readonly start: number;
      readonly end: number;
      readonly target: string;
    }
  | {
      /** 正文是替代文字。**圖片不載入**（ADR-0039 第三節），`src` 只拿來顯示 */
      readonly kind: 'image';
      readonly start: number;
      readonly end: number;
      readonly src: string;
    };

/** 放文字的那一層：段落、標題、儲存格、提示框的標題。 */
export interface MdLeaf {
  readonly start: number;
  readonly end: number;
  readonly inline: readonly MdInline[];
}

export interface MdListItem {
  /** 待辦清單的項目（`- [ ]`、`- [x]`） */
  readonly task: boolean;
  readonly checked: boolean;
  readonly children: readonly MdBlock[];
}

export type MdAlign = 'left' | 'center' | 'right' | null;

export type MdBlock =
  | ({ readonly kind: 'paragraph' } & MdLeaf)
  | ({ readonly kind: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6 } & MdLeaf)
  /** YAML frontmatter 的內容（不含 `---`），原樣顯示。**只會是第一塊** */
  | { readonly kind: 'frontmatter'; readonly start: number; readonly end: number }
  | {
      readonly kind: 'code';
      readonly start: number;
      readonly end: number;
      readonly lang: string | null;
    }
  /** 原始 HTML 區塊 —— **當文字顯示**，不解析成元素 */
  | { readonly kind: 'html'; readonly start: number; readonly end: number }
  | { readonly kind: 'hr' }
  | {
      readonly kind: 'list';
      readonly ordered: boolean;
      /** 有序清單的起始編號 */
      readonly first: number | null;
      readonly items: readonly MdListItem[];
    }
  | { readonly kind: 'quote'; readonly children: readonly MdBlock[] }
  | {
      /** Obsidian 的提示框：第一段以 `[!類型]` 開頭的引用 */
      readonly kind: 'callout';
      readonly callout: string;
      /** `[!note]+`／`[!note]-`：可以收合；這裡只記，不收合 */
      readonly fold: '+' | '-' | null;
      /** 沒寫標題是 `null` —— 畫面用類型的名稱 */
      readonly title: MdLeaf | null;
      readonly children: readonly MdBlock[];
    }
  | {
      readonly kind: 'table';
      readonly align: readonly MdAlign[];
      readonly head: readonly MdLeaf[];
      readonly rows: readonly (readonly MdLeaf[])[];
    };

/** 有位置的片段，照文件順序。 */
export interface MdSpan {
  readonly start: number;
  readonly end: number;
  readonly inline: readonly MdInline[];
}

/** 所有放文字的片段，照文件順序。 */
export function leavesOf(blocks: readonly MdBlock[]): readonly MdSpan[] {
  const out: MdSpan[] = [];
  const walk = (list: readonly MdBlock[]): void => {
    for (const block of list) {
      switch (block.kind) {
        case 'paragraph':
        case 'heading':
          out.push(block);
          break;
        case 'frontmatter':
        case 'code':
        case 'html':
          out.push({ start: block.start, end: block.end, inline: [] });
          break;
        case 'hr':
          break;
        case 'list':
          for (const item of block.items) walk(item.children);
          break;
        case 'quote':
          walk(block.children);
          break;
        case 'callout':
          if (block.title !== null) out.push(block.title);
          walk(block.children);
          break;
        case 'table':
          out.push(...block.head);
          for (const row of block.rows) out.push(...row);
          break;
      }
    }
  };
  walk(blocks);
  return out;
}

/**
 * 不變式。**回第一個違反的描述，全部成立回 `null`。**
 *
 * 1. 每一段都在 `text` 裡、照順序、不重疊
 * 2. 行內片段在所屬那一段裡面
 * 3. **看得到的字都在某一段裡** —— 落在段與段之間的只能是分隔用的空白。
 *    否則索引裡有一個字，畫面上卻沒有：搜得到、點過去找不到
 */
export function checkBlocks(text: string, blocks: readonly MdBlock[]): string | null {
  let at = 0;
  for (const leaf of leavesOf(blocks)) {
    if (!(Number.isInteger(leaf.start) && Number.isInteger(leaf.end))) return '位置不是整數';
    if (leaf.start < at) return `片段 ${String(leaf.start)} 跟前一段重疊或倒序`;
    if (leaf.end < leaf.start || leaf.end > text.length)
      return `片段 ${String(leaf.start)} 超出正文`;
    if (/\S/.test(text.slice(at, leaf.start))) return `位置 ${String(at)} 起有字不在任何片段裡`;
    for (const mark of leaf.inline) {
      if (mark.start < leaf.start || mark.end > leaf.end || mark.end < mark.start) {
        return `行內片段 ${String(mark.start)} 不在所屬那一段裡`;
      }
    }
    at = leaf.end;
  }
  if (/\S/.test(text.slice(at))) return `位置 ${String(at)} 起有字不在任何片段裡`;
  return null;
}

/**
 * 語言偵測用的文字：**跳過文件屬性**（ADR-0039 第一節）—— `tags:`、`created:` 這些英文鍵名
 * 會把一份短的中文筆記判成英文。
 */
export function prose(text: string, blocks: readonly MdBlock[] | null): string {
  const first = blocks?.[0];
  if (first?.kind !== 'frontmatter') return text;
  return text.slice(first.end).trimStart();
}

/** 第一個不小於 `value` 的位置（`map` 非遞減）。 */
function lowerBound(map: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = map.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((map[mid] as number) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 把**原文**（解析前的 Markdown）的一段 `[start, end)` 換到新正文上（ADR-0039 第五節的升級）。
 *
 * `map[i]` 是新正文第 `i` 個字在原文的位置，非遞減。新正文裡落在那一段原文裡的字就是答案；
 * 頭尾的分隔空白去掉。**一個字都沒落進去**（那一段原文全是記號）回 `null` —— 那就是對不上，不猜。
 */
export function remapRange(
  map: ArrayLike<number>,
  text: string,
  start: number,
  end: number,
): { readonly start: number; readonly end: number } | null {
  let from = lowerBound(map, start);
  let to = lowerBound(map, end);
  while (from < to && /\s/.test(text[from] as string)) from++;
  while (to > from && /\s/.test(text[to - 1] as string)) to--;
  return to > from ? { start: from, end: to } : null;
}
