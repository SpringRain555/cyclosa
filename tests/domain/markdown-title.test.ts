/**
 * Markdown 的標題（2026-10-28 試用回饋 4）：Obsidian 的筆記以 `---` 開頭，
 * 原本的「第一行」規則讓 4 份裡 3 份叫「---」。
 */
import { describe, expect, it } from 'vitest';

import {
  isMarkdown,
  markdownTitle,
  MAX_MARKDOWN_TITLE_CHARS,
  splitFrontmatter,
} from '../../src/domain/ingest/markdown.js';

const NOTE = ['---', 'tags: [notes]', 'created: 2026-10-20', '---', '', '正文第一句。'].join('\n');

describe('splitFrontmatter', () => {
  it('切出頂層的純量欄位，正文從收尾那一行之後開始', () => {
    const split = splitFrontmatter(
      ['---', 'title: "文獻回顧"', "author: '某人'", '---', '# 一級標題', '內文'].join('\n'),
    );
    expect(split.fields?.get('title')).toBe('文獻回顧');
    expect(split.fields?.get('author')).toBe('某人');
    expect(split.body).toBe('# 一級標題\n內文');
  });

  it('清單、多行字串不解析', () => {
    const split = splitFrontmatter(
      ['---', 'title: |', '  多行', 'aliases: [a, b]', '---'].join('\n'),
    );
    expect(split.fields?.has('title')).toBe(false);
    expect(split.fields?.has('aliases')).toBe(false);
  });

  it('沒收尾的 `---` 不算 frontmatter；CRLF 與 BOM 也認得', () => {
    expect(splitFrontmatter('---\n只有開頭').fields).toBeNull();
    expect(splitFrontmatter('\uFEFF---\r\ntitle: 甲\r\n---\r\n正文').fields?.get('title')).toBe(
      '甲',
    );
  });

  it('第一行不是 `---` 就沒有 frontmatter', () => {
    expect(splitFrontmatter('# 標題\n---\n').fields).toBeNull();
  });
});

describe('markdownTitle 的順序', () => {
  it('1. frontmatter 的 title', () => {
    expect(markdownTitle('---\ntitle: 明寫的標題\n---\n# 一級標題', '檔名.md')).toBe('明寫的標題');
  });

  it('2. 正文第一個一級標題 —— 不是 `---`', () => {
    expect(markdownTitle(`${NOTE}\n# 一級標題`, '檔名.md')).toBe('一級標題');
  });

  it('二級標題不算一級標題；程式碼區塊裡的 `#` 也不算', () => {
    const text = ['```bash', '# 這是註解', '```', '## 小節', '內文'].join('\n');
    expect(markdownTitle(text, 'Discussion 整理.md')).toBe('Discussion 整理');
  });

  it('3. 沒有標題就用檔名 —— Obsidian 的筆記名稱就是檔名', () => {
    expect(markdownTitle(NOTE, '專案規定.md')).toBe('專案規定');
  });

  it('4. 檔名像預設名才退回正文第一行', () => {
    expect(markdownTitle(NOTE, 'Untitled.md')).toBe('正文第一句。');
    expect(markdownTitle('## 背景\n內文', 'download (3).md')).toBe('背景');
  });

  it('標題有上限', () => {
    const long = `# ${'長'.repeat(MAX_MARKDOWN_TITLE_CHARS + 10)}`;
    expect(markdownTitle(long, 'x.md')).toHaveLength(MAX_MARKDOWN_TITLE_CHARS);
  });

  it('`.markdown` 副檔名也拿掉', () => {
    expect(markdownTitle('內文', '筆記.markdown')).toBe('筆記');
  });
});

describe('isMarkdown', () => {
  it('看型別，型別說不出來再看副檔名；純文字不算', () => {
    expect(isMarkdown('text/markdown; charset=utf-8', 'x')).toBe(true);
    expect(isMarkdown(null, 'a.md')).toBe(true);
    expect(isMarkdown('application/octet-stream', 'A.MARKDOWN')).toBe(true);
    expect(isMarkdown('text/plain', 'a.txt')).toBe(false);
  });
});
