/**
 * 守門：**升抽取器版本，就要寫下那一版改了哪幾種資料。**
 *
 * ## 這一條在守什麼
 *
 * `EXTRACTOR_VERSION` 升了之後，已經存在的 `derived/` 由 App 升級（ADR-0039 第五節，`application/case-upgrade.ts`）：
 * **改過的種類從快照重抽，沒改過的只換版號**。判斷「改過沒有」的就是 `EXTRACTOR_CHANGES`。
 *
 * 漏寫那一列的症狀是**安靜的**：`changedSince` 對那一版一律回 false，升級只把舊正文換個版號 ——
 * 使用者看到的是「升級了，怎麼什麼都沒變」，而 `readDerived` 讀到的是一份貼著新版號的舊產物。
 *
 * > 這一條寫下來的時候對現況是零命中（v2 那一列剛寫好），
 * > 所以底下有一條把「升了版沒寫」的狀況餵回去，確認判準會紅。
 */
import { describe, expect, it } from 'vitest';

import {
  EXTRACTOR_CHANGES,
  EXTRACTOR_VERSION,
  changedSince,
} from '../../src/infrastructure/fs/case-files.js';

/** 從 2 到現在這一版，哪幾版沒寫改了什麼。 */
function versionsWithoutEntry(
  current: number,
  changes: Readonly<Record<number, readonly string[]>>,
): number[] {
  const missing: number[] = [];
  for (let version = 2; version <= current; version++) {
    if ((changes[version]?.length ?? 0) === 0) missing.push(version);
  }
  return missing;
}

describe('抽取器版本', () => {
  it('每一次升版都寫下了改了哪幾種資料', () => {
    expect(versionsWithoutEntry(EXTRACTOR_VERSION, EXTRACTOR_CHANGES)).toEqual([]);
  });

  it('判準認得出「升了版、沒寫」', () => {
    expect(versionsWithoutEntry(3, { 2: ['pdf'] })).toEqual([3]);
    expect(versionsWithoutEntry(3, { 2: ['pdf'], 3: [] })).toEqual([3]);
  });

  it('v1 的 PDF 要重抽（v2 改了 PDF）；v2 的網頁不用（v2、v3 都沒改網頁）；v2 的純文字要重抽（v3 改了 Markdown）', () => {
    expect(changedSince('pdf', 1)).toBe(true);
    expect(changedSince('pdf', 2)).toBe(false);
    expect(changedSince('web', 1)).toBe(false);
    expect(changedSince('text', 2)).toBe(true);
    expect(changedSince('text', EXTRACTOR_VERSION)).toBe(false);
  });
});
