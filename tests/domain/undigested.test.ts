import { expect, it } from 'vitest';
import { isUndigested, type DigestFacts } from '../../src/domain/research/undigested.js';

const fresh: DigestFacts = {
  kind: 'text',
  status: 'included',
  digestedAt: null,
  digestedBy: null,
  titleZh: null,
  summaryZh: null,
  hasBody: true,
};

it('未初讀且有正文的匯入資料可以補繁中', () => {
  expect(isUndigested(fresh)).toBe(true);
  expect(isUndigested({ ...fresh, status: 'parsed' })).toBe(true);
});

it.each<Partial<DigestFacts>>([
  { digestedAt: 0 },
  { digestedBy: 'old-model' },
  { titleZh: '既有標題' },
  { summaryZh: '既有摘要' },
  { kind: 'note' },
  { kind: 'reference' },
  { status: 'excluded' },
  { status: 'failed' },
  { status: 'pending' },
  { hasBody: false },
])('保留舊初讀與不可讀資料：%j', (change) => {
  expect(isUndigested({ ...fresh, ...change })).toBe(false);
});
