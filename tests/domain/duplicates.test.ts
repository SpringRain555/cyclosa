/**
 * 同一篇換了一個網址（2026-10-28 試用回饋 8）。網址全部是合成的。
 */
import { describe, expect, it } from 'vitest';

import {
  findDuplicates,
  identityKeys,
  MIN_TITLE_KEY_CHARS,
} from '../../src/domain/research/duplicates.js';
import { defaultDecision, effectiveDecision } from '../../src/domain/research/index.js';

const keysOf = (url: string, ...titles: string[]): string[] =>
  identityKeys(url, titles).map((k) => k.key);

describe('identityKeys', () => {
  it('期刊頁與 doi.org 認出同一個 DOI', () => {
    const a = keysOf('https://journal.example.org/doi/10.1234/abcd.5678');
    const b = keysOf('https://doi.org/10.1234/ABCD.5678');
    expect(a).toContain('doi:10.1234/abcd.5678');
    expect(b).toContain('doi:10.1234/abcd.5678');
  });

  it('預印本站的頁面種類與版本號不算進 DOI', () => {
    for (const url of [
      'https://preprint.example.org/content/10.1101/2020.04.17.046672v1',
      'https://preprint.example.org/content/10.1101/2020.04.17.046672v2.full',
      'https://preprint.example.org/content/10.1101/2020.04.17.046672v1.full.pdf',
    ]) {
      expect(keysOf(url)).toContain('doi:10.1101/2020.04.17.046672');
    }
  });

  it('arXiv 的 abs、pdf、html 與版本號是同一篇', () => {
    for (const url of [
      'https://arxiv.org/abs/2401.01234',
      'https://arxiv.org/pdf/2401.01234v3',
      'https://arxiv.org/html/2401.01234v2',
    ]) {
      expect(keysOf(url)).toContain('arxiv:2401.01234');
    }
  });

  it('PMC 與 PubMed 的編號', () => {
    expect(keysOf('https://pmc.example.org/articles/PMC1234567/')).toContain('pmc:1234567');
    expect(keysOf('https://pubmed.ncbi.nlm.nih.gov/30886413/')).toContain('pmid:30886413');
  });

  it('標題拿掉網站尾巴、大小寫與標點不算；太短的標題不當鍵', () => {
    const a = keysOf('', 'A Synthetic Study of Graph Benchmarks | Preprint Server');
    const b = keysOf('', 'a synthetic study of graph benchmarks.');
    expect(a.filter((k) => b.includes(k))).toHaveLength(1);
    expect(keysOf('', 'Introduction')).toEqual([]);
    expect('introduction'.length).toBeLessThan(MIN_TITLE_KEY_CHARS);
  });
});

describe('findDuplicates', () => {
  it('同一篇的兩個網址：先登記的是正本，另一份標成重複', () => {
    const found = findDuplicates(
      [],
      [
        {
          id: 'pmc',
          url: 'https://pmc.example.org/articles/PMC1234567/',
          titles: ['A Synthetic Study of Graph Benchmarks'],
          fetched: true,
        },
        {
          id: 'journal',
          url: 'https://journal.example.org/doi/10.1234/abcd.5678',
          titles: ['A Synthetic Study of Graph Benchmarks | Journal'],
          fetched: true,
        },
      ],
    );
    expect(found.get('journal')).toEqual({ id: 'pmc', kind: 'candidate', reason: 'title' });
    expect(found.has('pmc')).toBe(false);
  });

  it('抓到正文的那一份當正本，就算它排在後面', () => {
    const found = findDuplicates(
      [],
      [
        { id: 'abstract', url: 'https://arxiv.org/abs/2401.01234', titles: [], fetched: false },
        { id: 'pdf', url: 'https://arxiv.org/pdf/2401.01234v2', titles: [], fetched: true },
      ],
    );
    expect(found.get('abstract')).toEqual({ id: 'pdf', kind: 'candidate', reason: 'arxiv' });
    expect(found.has('pdf')).toBe(false);
  });

  it('專題裡已經有的永遠是正本', () => {
    const found = findDuplicates(
      [{ id: 'item-1', url: 'https://doi.org/10.1234/abcd.5678', titles: ['任一個標題'] }],
      [
        {
          id: 'c1',
          url: 'https://journal.example.org/doi/10.1234/abcd.5678/full',
          titles: [],
          fetched: true,
        },
      ],
    );
    expect(found.get('c1')).toEqual({ id: 'item-1', kind: 'item', reason: 'doi' });
  });

  it('不相干的兩份不撞', () => {
    const found = findDuplicates(
      [],
      [
        {
          id: 'a',
          url: 'https://a.example.org/1',
          titles: ['A Synthetic Study of Graph Benchmarks'],
          fetched: true,
        },
        {
          id: 'b',
          url: 'https://b.example.org/2',
          titles: ['Another Synthetic Paper on Retrieval'],
          fetched: true,
        },
      ],
    );
    expect(found.size).toBe(0);
  });
});

describe('可能重複的預設是不進圖，人可以改', () => {
  it('預設不進圖，不管有沒有抓到、初讀說什麼', () => {
    for (const acquisition of ['fetched', 'found', 'needs-user'] as const) {
      expect(
        defaultDecision({ acquisition, relevance: 'yes', digestCode: null, duplicate: true }),
      ).toBe('discard');
    }
  });

  it('人改過就照人的', () => {
    expect(
      effectiveDecision({
        acquisition: 'fetched',
        relevance: 'yes',
        digestCode: null,
        decision: 'include',
        duplicate: true,
      }),
    ).toBe('include');
  });
});
