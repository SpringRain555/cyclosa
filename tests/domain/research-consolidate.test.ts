import { describe, expect, it } from 'vitest';

import {
  extractedByRun,
  isUnextracted,
  type ExtractionFacts,
} from '../../src/domain/research/index.js';

const fresh: ExtractionFacts = {
  kind: 'pdf',
  status: 'included',
  extractedAt: null,
  machineEvidence: 0,
  hasBody: true,
};

describe('還沒抽過的資料（整理的第一片）', () => {
  it('匯入完成、有正文、沒抽過、沒有機器關聯拿它當出處 → 列出來', () => {
    expect(isUnextracted(fresh)).toBe(true);
    expect(isUnextracted({ ...fresh, status: 'parsed' })).toBe(true);
    expect(isUnextracted({ ...fresh, kind: 'web' })).toBe(true);
  });

  it('研究建圖抽過的（`extracted_at` 有值）不列', () => {
    expect(isUnextracted({ ...fresh, extractedAt: 1 })).toBe(false);
  });

  it('v12 以前抽過的：那一欄是空的，但有機器建的關聯拿它當出處 → 不列', () => {
    expect(isUnextracted({ ...fresh, machineEvidence: 3 })).toBe(false);
  });

  it('沒有正文（圖片、掃描件）、書目節點、筆記不列', () => {
    expect(isUnextracted({ ...fresh, hasBody: false })).toBe(false);
    expect(isUnextracted({ ...fresh, kind: 'reference' })).toBe(false);
    expect(isUnextracted({ ...fresh, kind: 'note' })).toBe(false);
  });

  it('排除的、失敗的、還沒抓完的不列', () => {
    for (const status of ['excluded', 'failed', 'pending', 'fetched']) {
      expect(isUnextracted({ ...fresh, status }), status).toBe(false);
    }
  });
});

describe('復原一筆作業時，哪些「抽過了」要清回去', () => {
  const run = { startedAt: 100, endedAt: 200 };

  it('這一筆作業區間裡寫的才清', () => {
    expect(extractedByRun(150, run, 999)).toBe(true);
    expect(extractedByRun(100, run, 999)).toBe(true);
    expect(extractedByRun(200, run, 999)).toBe(true);
  });

  it('之後被別的作業抽過（時間在區間外）的不清；沒抽過的不清', () => {
    expect(extractedByRun(250, run, 999)).toBe(false);
    expect(extractedByRun(50, run, 999)).toBe(false);
    expect(extractedByRun(null, run, 999)).toBe(false);
  });

  it('還沒結束的作業用現在當區間的尾巴；沒開始過的不清', () => {
    expect(extractedByRun(500, { startedAt: 100, endedAt: null }, 999)).toBe(true);
    expect(extractedByRun(150, { startedAt: null, endedAt: null }, 999)).toBe(false);
  });
});
