/**
 * 錯誤碼的三邊對照。
 *
 *   src/domain/errors/codes.ts   ← **單一真實來源**
 *   docs/architecture/error-codes.md  ← 它的說明
 *   web/src/i18n/zh-TW.ts        ← 它的繁中訊息
 *
 * **任一邊多一個或少一個就紅**（REQ-0008）。
 *
 * 這條測試存在的理由很具體：一個沒有訊息的錯誤碼，
 * 對使用者而言等於「壞了，自己想辦法」；
 * 而一個文件裡有、程式裡沒有的碼，會讓照著文件除錯的人一直找不到它。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_ERROR_CODES, ERROR_CODES, ERROR_LEVELS } from '../../src/domain/errors/codes.js';
import { errorMessages } from '../../web/src/i18n/zh-TW.js';
import { REPO_ROOT } from './helpers.js';

const DOC = join(REPO_ROOT, 'docs', 'architecture', 'error-codes.md');

/** 文件裡的碼寫在表格第一欄，格式是 `` `CODE` ``。 */
function codesInDoc(): Set<string> {
  const text = readFileSync(DOC, 'utf8');
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    const m = /^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/.exec(line);
    if (m?.[1] !== undefined) found.add(m[1]);
  }
  return found;
}

describe('錯誤碼三邊一致', () => {
  const doc = codesInDoc();
  const code = new Set<string>(ALL_ERROR_CODES);
  const i18n = new Set(Object.keys(errorMessages));

  it('掃得到碼（不然這條測試是死的）', () => {
    expect(code.size).toBeGreaterThan(30);
    expect(doc.size).toBeGreaterThan(30);
  });

  it('程式有而文件沒有的：無', () => {
    expect([...code].filter((c) => !doc.has(c)).sort()).toEqual([]);
  });

  it('文件有而程式沒有的：無', () => {
    expect([...doc].filter((c) => !code.has(c)).sort()).toEqual([]);
  });

  it('程式有而 i18n 沒有訊息的：無', () => {
    expect([...code].filter((c) => !i18n.has(c)).sort()).toEqual([]);
  });

  it('i18n 有而程式沒有的：無', () => {
    expect([...i18n].filter((c) => !code.has(c)).sort()).toEqual([]);
  });

  it('每個級別都是合法值', () => {
    const bad = Object.entries(ERROR_CODES).filter(
      ([, level]) => !(ERROR_LEVELS as readonly string[]).includes(level),
    );
    expect(bad).toEqual([]);
  });

  it('每則訊息都不是空的，而且不含錯誤碼本身', () => {
    // **碼只進日誌，不進 UI** —— 訊息裡出現碼就是把它洩進畫面了
    const bad = Object.entries(errorMessages).filter(
      ([c, msg]) => msg.trim().length === 0 || msg.includes(c),
    );
    expect(bad).toEqual([]);
  });

  it('每一組都有 *_UNEXPECTED', () => {
    const groups = new Set([...code].map((c) => c.split('_')[0]));
    const missing = [...groups].filter(
      (g) => ![...code].some((c) => c.startsWith(`${g}_`) && c.endsWith('_UNEXPECTED')),
    );
    expect(missing).toEqual([]);
  });
});
