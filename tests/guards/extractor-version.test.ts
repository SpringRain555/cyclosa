/**
 * 守門：**升抽取器版本，就要寫下那一版改了哪幾種資料。**
 *
 * ## 這一條在守什麼
 *
 * `EXTRACTOR_VERSION` 升了之後，已經存在的 `derived/` 都是舊版抽的，要按「重算全部正文」
 * 才換成新的。閱讀器會對舊版的正文說一句「這份是舊版抽的」—— **但只對真的變了的那幾種**
 * （`EXTRACTOR_CHANGES`）：v2 只改了 PDF 的重排，網頁也標舊版的話，使用者會去按一顆
 * 對那一份沒有用的按鈕。
 *
 * 漏寫那一列的症狀是**安靜的**：`isStaleDerived` 對那一版一律回 false，
 * 閱讀器不說話，而使用者看到的是「升級了，排版怎麼沒變」。
 *
 * > 這一條寫下來的時候對現況是零命中（v2 那一列剛寫好），
 * > 所以底下有一條把「升了版沒寫」的狀況餵回去，確認判準會紅。
 */
import { describe, expect, it } from 'vitest';

import {
  EXTRACTOR_CHANGES,
  EXTRACTOR_VERSION,
  isStaleDerived,
  type DerivedPayload,
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

function payload(kind: DerivedPayload['kind'], extractorVersion: number): DerivedPayload {
  return {
    extractorVersion,
    kind,
    title: '',
    text: '',
    html: null,
    pages: null,
    excerpt: '',
    lowConfidence: false,
    reasons: [],
  };
}

describe('抽取器版本', () => {
  it('每一次升版都寫下了改了哪幾種資料', () => {
    expect(versionsWithoutEntry(EXTRACTOR_VERSION, EXTRACTOR_CHANGES)).toEqual([]);
  });

  it('判準認得出「升了版、沒寫」', () => {
    expect(versionsWithoutEntry(3, { 2: ['pdf'] })).toEqual([3]);
    expect(versionsWithoutEntry(3, { 2: ['pdf'], 3: [] })).toEqual([3]);
  });

  it('舊版抽的 PDF 算舊；舊版抽的網頁不算（v2 沒改網頁）；現在這一版抽的都不算', () => {
    expect(isStaleDerived(payload('pdf', 1))).toBe(true);
    expect(isStaleDerived(payload('web', 1))).toBe(false);
    expect(isStaleDerived(payload('pdf', EXTRACTOR_VERSION))).toBe(false);
  });
});
