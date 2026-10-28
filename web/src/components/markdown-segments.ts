/**
 * 一段放文字的（段落、標題、儲存格）切成片段：每一片是**同一組**行內樣式＋同一則點註（ADR-0039 第二節）。
 *
 * 片段的字接起來就是正文的那一段，一字不多 —— 閱讀器的選取換算（`offsetWithin` 數文字節點）靠的就是這一點。
 * 樣式由外而內排（範圍大的在外），點註的高亮包在最裡面，`[data-note]` 底下只有字。
 */
/** 行內樣式只要有位置就能切（`MdInline` 的形狀）。這一份不 import `api.ts`：測試從伺服器那邊的設定也編得到它。 */
interface Positioned {
  readonly start: number;
  readonly end: number;
}

export interface NoteSpan {
  readonly id: string;
  readonly start: number;
  readonly end: number;
}

export interface Segment<M extends Positioned = Positioned> {
  readonly text: string;
  /** 外到內 */
  readonly marks: readonly M[];
  readonly noteId: string | null;
}

export function segmentLeaf<M extends Positioned>(
  text: string,
  leaf: { readonly start: number; readonly end: number; readonly inline: readonly M[] },
  notes: readonly NoteSpan[],
): readonly Segment<M>[] {
  const clamp = (n: number): number => Math.min(leaf.end, Math.max(leaf.start, n));
  const cuts = new Set<number>([leaf.start, leaf.end]);
  for (const mark of leaf.inline) {
    cuts.add(clamp(mark.start));
    cuts.add(clamp(mark.end));
  }
  const touching = notes.filter((n) => n.end > leaf.start && n.start < leaf.end);
  for (const note of touching) {
    cuts.add(clamp(note.start));
    cuts.add(clamp(note.end));
  }
  const points = [...cuts].sort((a, b) => a - b);
  const out: Segment<M>[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const start = points[i] as number;
    const end = points[i + 1] as number;
    if (end <= start) continue;
    const marks = leaf.inline
      .filter((m) => m.end > m.start && m.start <= start && m.end >= end)
      .sort((a, b) => a.start - b.start || b.end - a.end);
    const note = touching.find((n) => n.start <= start && n.end >= end) ?? null;
    out.push({ text: text.slice(start, end), marks, noteId: note?.id ?? null });
  }
  return out;
}

/** 連結只認 http／https／mailto（ADR-0039 第三節）。伺服器判過一次，畫之前再判一次。 */
export function safeHref(href: string | null): string | null {
  if (href === null) return null;
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : null;
}
