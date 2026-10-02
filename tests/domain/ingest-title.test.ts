/**
 * 匯入的檔案叫什麼名字（`domain/ingest/title.ts`）。
 *
 * 2026-10-02：一本書的 28 章，PDF 檔案裡的標題全是瀏覽器填的網址，檔名才是章名。
 */
import { describe, expect, it } from 'vitest';

import {
  looksLikeDefaultName,
  pickTitle,
  stripDocumentExtension,
} from '../../src/domain/ingest/title.js';

describe('looksLikeDefaultName', () => {
  it.each([
    'deeplearningbook.org/contents/linear_algebra.html',
    'deeplearningbook.org_contents_linear_algebra.html',
    'https://example.org/paper',
    'www.example.org',
    'report.pdf',
    'Untitled',
    'Untitled document',
    'Document1',
    'Microsoft Word - 期末報告.docx',
    'download (3)',
    'Scan_0001',
    'IMG_2041',
    '8f3a9c1e2b7d',
    '20260930_1530',
    '無標題文件',
    '',
    '   ',
  ])('%s → 預設名', (name) => {
    expect(looksLikeDefaultName(name)).toBe(true);
  });

  it.each([
    '2 Linear Algebra',
    'Table of Contents',
    'Deep Learning',
    'Vol.2_Notes',
    'U.S. Policy Report',
    '個人資料保護法施行細則',
    'Attention Is All You Need',
  ])('%s → 人取的標題', (name) => {
    expect(looksLikeDefaultName(name)).toBe(false);
  });
});

describe('pickTitle', () => {
  it('**這次的情形**：檔案裡是網址、檔名是章名 → 用檔名（去副檔名）', () => {
    expect(
      pickTitle({
        embedded: 'deeplearningbook.org/contents/linear_algebra.html',
        fileName: '2 Linear Algebra.pdf',
      }),
    ).toBe('2 Linear Algebra');
  });

  it('檔案裡的標題是人取的 → 用它（原本的行為）', () => {
    expect(pickTitle({ embedded: 'Attention Is All You Need', fileName: '1706.03762v7.pdf' })).toBe(
      'Attention Is All You Need',
    );
  });

  it('檔案裡沒有標題 → 用檔名（去副檔名）', () => {
    expect(pickTitle({ embedded: null, fileName: '期末報告.pdf' })).toBe('期末報告');
    expect(pickTitle({ embedded: '   ', fileName: '期末報告.pdf' })).toBe('期末報告');
  });

  it('兩邊都像預設名 → 留檔案裡的那一格（之後交給模型提名字）', () => {
    expect(
      pickTitle({ embedded: 'Microsoft Word - 草稿.docx', fileName: 'download (3).pdf' }),
    ).toBe('Microsoft Word - 草稿.docx');
  });

  it('兩邊都沒東西 → 至少回原本的檔名，不回空字串', () => {
    expect(pickTitle({ embedded: null, fileName: '.pdf' })).toBe('.pdf');
  });
});

describe('stripDocumentExtension', () => {
  it('只去常見的文件副檔名', () => {
    expect(stripDocumentExtension('a.pdf')).toBe('a');
    expect(stripDocumentExtension('a.HTML')).toBe('a');
    expect(stripDocumentExtension('version 1.2')).toBe('version 1.2');
  });
});
