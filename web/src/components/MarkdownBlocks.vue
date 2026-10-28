<script setup lang="ts">
/**
 * Markdown 照結構畫（ADR-0039 第二節）。**全程不用 `v-html`** —— 每一片字都是文字節點，樣式是包在外面的元素。
 *
 * 只有放文字的那一層（段落、標題、儲存格、程式碼、文件屬性、提示框標題）帶 `data-start`，而且裡面只有正文的字：
 * 清單符號、待辦方框、提示框的預設標題、圖片圖示都是樣式，或放在那一層外面 —— 閱讀器的選取換算（`offsetWithin`）
 * 數的是文字節點，多一個字就偏一格。
 *
 * 行內的元素由 `h()` 建（片段的組合數不固定，寫成範本要一層一層遞迴），樣式用 `:deep()` 掛上去。
 */
import { h, type FunctionalComponent, type VNode } from 'vue';

import type { MdBlock, MdInline, MdLeaf } from '../api';
import { fill, t } from '../i18n/zh-TW';
import { safeHref, segmentLeaf, type NoteSpan, type Segment } from './markdown-segments';

const props = withDefaults(
  defineProps<{
    text: string;
    blocks: readonly MdBlock[];
    /** 解得出位置的點註（正文的位置） */
    notes?: readonly NoteSpan[];
    /** 「在正文裡找到它」按下去之後暫時提亮的那一則 */
    locatedId?: string | null;
  }>(),
  { notes: () => [], locatedId: null },
);

const EXTERNAL = { target: '_blank', rel: 'noopener noreferrer' } as const;

function wrap(mark: MdInline, child: VNode | string): VNode {
  switch (mark.kind) {
    case 'strong':
      return h('strong', null, [child]);
    case 'em':
      return h('em', null, [child]);
    case 'del':
      return h('del', null, [child]);
    case 'mark':
      return h('mark', { class: 'md-mark' }, [child]);
    case 'code':
      return h('code', { class: 'md-code' }, [child]);
    case 'html':
      // 原始 HTML **當文字顯示**（ADR-0039 第三節）。
      return h('span', { class: 'md-raw' }, [child]);
    case 'link': {
      const href = safeHref(mark.href);
      return href === null
        ? h('span', { class: 'md-link-off', title: mark.target }, [child])
        : h('a', { href, title: mark.target, ...EXTERNAL }, [child]);
    }
    case 'wikilink':
      return h('span', { class: 'md-wiki', title: mark.target }, [child]);
    case 'embed':
      return h('span', { class: 'md-embed', title: mark.target }, [child]);
    case 'image': {
      // **圖片不載入**：字是替代文字，網址在提示裡；點了另開分頁看原網址。
      const title = fill(t.markdown.imageNotLoaded, { src: mark.src });
      const href = safeHref(mark.src);
      return href === null
        ? h('span', { class: 'md-image', title }, [child])
        : h('a', { class: 'md-image', href, title, ...EXTERNAL }, [child]);
    }
  }
}

function render(segment: Segment<MdInline>): VNode | string {
  let node: VNode | string = segment.text;
  if (segment.noteId !== null) {
    node = h(
      'mark',
      {
        class: ['hl', { located: segment.noteId === props.locatedId }],
        'data-note': segment.noteId,
      },
      [node],
    );
  }
  for (let i = segment.marks.length - 1; i >= 0; i--)
    node = wrap(segment.marks[i] as MdInline, node);
  return node;
}

/** 一段放文字的：切成片段、一片一片包起來。 */
const Leaf: FunctionalComponent<{ leaf: Pick<MdLeaf, 'start' | 'end' | 'inline'> }> = (p) =>
  segmentLeaf(props.text, p.leaf, props.notes).map(render);

function plain(block: { start: number; end: number }): Pick<MdLeaf, 'start' | 'end' | 'inline'> {
  return { start: block.start, end: block.end, inline: [] };
}

function headingTag(level: number): string {
  // 文件裡的一級標題排在閱讀器的標題底下：往下挪一級。
  return `h${String(Math.min(6, level + 1))}`;
}

function calloutLabel(kind: string): string {
  return (t.markdown.callouts as Readonly<Record<string, string>>)[kind] ?? kind;
}

function alignOf(align: 'left' | 'center' | 'right' | null | undefined): Record<string, string> {
  return align ? { textAlign: align } : {};
}
</script>

<template>
  <template v-for="(b, i) in blocks" :key="i">
    <div v-if="b.kind === 'frontmatter'" class="md-props">
      <p class="md-props-label">{{ t.markdown.properties }}</p>
      <div class="md-leaf md-props-body" :data-start="b.start"><Leaf :leaf="plain(b)" /></div>
    </div>
    <component
      :is="headingTag(b.level)"
      v-else-if="b.kind === 'heading'"
      class="md-leaf md-h"
      :class="`md-h${b.level}`"
      :data-start="b.start"
      ><Leaf :leaf="b"
    /></component>
    <p v-else-if="b.kind === 'paragraph'" class="md-leaf md-p" :data-start="b.start">
      <Leaf :leaf="b" />
    </p>
    <div v-else-if="b.kind === 'code'" class="md-leaf md-block-code" :data-start="b.start">
      <Leaf :leaf="plain(b)" />
    </div>
    <div
      v-else-if="b.kind === 'html'"
      class="md-leaf md-block-code md-raw-block"
      :data-start="b.start"
    >
      <Leaf :leaf="plain(b)" />
    </div>
    <hr v-else-if="b.kind === 'hr'" class="md-hr" />
    <component
      :is="b.ordered ? 'ol' : 'ul'"
      v-else-if="b.kind === 'list'"
      class="md-list"
      :start="b.ordered && b.first !== null ? b.first : undefined"
    >
      <li
        v-for="(item, j) in b.items"
        :key="j"
        :class="{ 'md-task': item.task, 'md-done': item.task && item.checked }"
      >
        <MarkdownBlocks
          :text="text"
          :blocks="item.children"
          :notes="notes"
          :located-id="locatedId"
        />
      </li>
    </component>
    <blockquote v-else-if="b.kind === 'quote'" class="md-quote">
      <MarkdownBlocks :text="text" :blocks="b.children" :notes="notes" :located-id="locatedId" />
    </blockquote>
    <aside v-else-if="b.kind === 'callout'" class="md-callout" :data-callout="b.callout">
      <p v-if="b.title" class="md-leaf md-callout-title" :data-start="b.title.start">
        <Leaf :leaf="b.title" />
      </p>
      <p v-else class="md-callout-title">{{ calloutLabel(b.callout) }}</p>
      <MarkdownBlocks :text="text" :blocks="b.children" :notes="notes" :located-id="locatedId" />
    </aside>
    <div v-else-if="b.kind === 'table'" class="md-table-wrap">
      <table class="md-table">
        <thead>
          <tr>
            <th
              v-for="(cell, c) in b.head"
              :key="c"
              class="md-leaf"
              :data-start="cell.start"
              :style="alignOf(b.align[c])"
            >
              <Leaf :leaf="cell" />
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, r) in b.rows" :key="r">
            <td
              v-for="(cell, c) in row"
              :key="c"
              class="md-leaf"
              :data-start="cell.start"
              :style="alignOf(b.align[c])"
            >
              <Leaf :leaf="cell" />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>

<style scoped>
/* 段落裡的單一換行照原文斷行（Obsidian 預設就是這樣顯示）。 */
.md-leaf {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.md-p {
  margin: 0 0 1em;
}
.md-h {
  margin: 1.2em 0 0.5em;
  font-weight: 600;
  line-height: 1.4;
}
.md-h1 {
  font-size: var(--fs-title);
}
.md-h2 {
  font-size: var(--fs-section);
}
.md-h3,
.md-h4,
.md-h5,
.md-h6 {
  font-size: inherit;
}
.md-props {
  margin: 0 0 1.2em;
  padding: var(--s2) var(--s3);
  border: 1px solid var(--line-subtle);
  border-radius: var(--radius);
  background: var(--bg-raised);
}
.md-props-label {
  margin: 0 0 var(--s1);
  font-size: var(--fs-label);
  color: var(--text-tertiary);
}
.md-props-body {
  font-family: var(--mono);
  font-size: var(--fs-small);
  color: var(--text-secondary);
}
.md-block-code {
  margin: 0 0 1em;
  padding: var(--s2) var(--s3);
  border-radius: var(--radius);
  background: var(--bg-raised);
  font-family: var(--mono);
  font-size: var(--fs-small);
  white-space: pre;
  overflow-x: auto;
}
.md-raw-block {
  color: var(--text-secondary);
}
.md-hr {
  border: 0;
  border-top: 1px solid var(--line);
  margin: 1.5em 0;
}
.md-list {
  margin: 0 0 1em;
  padding-left: 1.6em;
}
.md-list .md-list {
  margin-bottom: 0;
}
.md-list > li > :deep(.md-p) {
  margin-bottom: 0.25em;
}
/* 待辦的方框是樣式，不是正文的字。 */
.md-task {
  list-style: none;
}
.md-task::before {
  content: '\2610';
  margin-left: -1.3em;
  margin-right: 0.3em;
  float: left;
  color: var(--text-tertiary);
}
.md-done::before {
  content: '\2611';
  color: var(--ui-success);
}
.md-done > :deep(.md-p) {
  color: var(--text-secondary);
}
.md-quote {
  margin: 0 0 1em;
  padding: 0 0 0 var(--s3);
  border-left: 3px solid var(--line-strong);
  color: var(--text-secondary);
}
.md-callout {
  margin: 0 0 1em;
  padding: var(--s2) var(--s3);
  border: 1px solid var(--line);
  border-left: 3px solid var(--ui-action);
  border-radius: var(--radius);
  background: var(--bg-raised);
}
.md-callout-title {
  margin: 0 0 var(--s1);
  font-weight: 600;
}
.md-table-wrap {
  margin: 0 0 1em;
  max-width: 100%;
  overflow-x: auto;
}
.md-table th,
.md-table td {
  vertical-align: top;
}
/* 表頭照原文的對齊；沒寫就靠左，跟資料列一致（瀏覽器預設的表頭置中）。 */
.md-table th {
  text-align: start;
}
.md-leaf :deep(.md-code) {
  padding: 0 0.25em;
  border-radius: var(--radius);
  background: var(--bg-raised);
  font-family: var(--mono);
  font-size: var(--fs-small);
}
.md-leaf :deep(.md-mark) {
  background: color-mix(in srgb, var(--ui-action) 18%, transparent);
  color: inherit;
}
.md-leaf :deep(.md-raw) {
  font-family: var(--mono);
  color: var(--text-secondary);
}
.md-leaf :deep(.md-wiki) {
  color: var(--ui-action);
}
.md-leaf :deep(.md-embed),
.md-leaf :deep(.md-image) {
  padding: 0 0.3em;
  border: 1px dashed var(--line-strong);
  border-radius: var(--radius);
  color: var(--text-secondary);
}
.md-leaf :deep(.md-image)::before {
  content: '\25A3\00A0';
  color: var(--text-tertiary);
}
.md-leaf :deep(.md-link-off) {
  text-decoration: underline dotted;
}
/* 點註的高亮：跟 ReaderView 的 `.hl` 同一個畫法（暖色底＋底線，ADR-0018 規則 2）。 */
.md-leaf :deep(.hl) {
  background: color-mix(in srgb, var(--node-note) 22%, transparent);
  border-bottom: 1px solid var(--node-note);
  color: inherit;
  padding: 0 1px;
}
.md-leaf :deep(.hl.located) {
  background: color-mix(in srgb, var(--node-note) 42%, transparent);
}
</style>
