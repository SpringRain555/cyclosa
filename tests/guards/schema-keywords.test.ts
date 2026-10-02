/**
 * 守門：**送給模型的 schema 只用 `conformsTo` 認得的關鍵字。**
 *
 * ## 為什麼需要這一條
 *
 * `domain/provider/schema-check.ts` 遇到清單外的關鍵字一律判不通過 —— 略過的意思是
 * 「那一條限制沒有被檢查，而結果寫著通過」。所以 schema 一旦用了清單外的關鍵字，
 * 只到 `json_object` 的端點每一次回應都會被判成不符合，而症狀看起來像模型壞了。
 *
 * `schema-check.ts` 的註解從寫下來那天就說「`tests/guards/schema-keywords.test.ts` 釘住
 * 三份 schema 只用得到這些」，**而那個檔案 2026-09-14 之前不存在** —— `D:\Projects` 全面檢查
 * 文件引用時才發現。一條宣稱存在、實際沒有的守門，跟一條沒有人想到要寫的守門一樣沒有保護作用，
 * 而且更糟：讀註解的人會以為這件事有人管。
 */
import { describe, expect, it } from 'vitest';

import { EXTRACT_SCHEMA } from '../../src/application/extraction-prompts.js';
import {
  CANDIDATES_SCHEMA,
  DIGEST_SCHEMA,
  PLAN_SCHEMA,
} from '../../src/application/research-prompts.js';
import { SUPPORTED_KEYWORDS } from '../../src/domain/provider/schema-check.js';
import { PROBE_SCHEMA } from '../../src/infrastructure/providers/chat-openai.js';

/** 不構成限制的註記，`schema-check.ts` 放行它們（同一份清單）。 */
const ANNOTATIONS = new Set(['description', 'title', '$schema']);

/**
 * 一份 schema 用到的關鍵字。`properties` 底下的是欄位名不是關鍵字，
 * 所以往它的值裡面走；`items`／`additionalProperties` 是子 schema，也往裡面走。
 */
function keywordsOf(schema: unknown, out = new Set<string>()): Set<string> {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return out;
  for (const [key, value] of Object.entries(schema)) {
    out.add(key);
    if (key === 'properties' && value !== null && typeof value === 'object') {
      for (const child of Object.values(value)) keywordsOf(child, out);
    } else if (key === 'items' || key === 'additionalProperties') {
      keywordsOf(value, out);
    }
  }
  return out;
}

function unsupported(schema: unknown): string[] {
  const allowed = new Set<string>([...SUPPORTED_KEYWORDS, ...ANNOTATIONS]);
  return [...keywordsOf(schema)].filter((k) => !allowed.has(k)).sort();
}

describe('送給模型的 schema 只用 conformsTo 認得的關鍵字', () => {
  it.each([
    ['DIGEST_SCHEMA', DIGEST_SCHEMA],
    ['EXTRACT_SCHEMA', EXTRACT_SCHEMA],
    // 研究的兩份。**規劃那一份 Stage 19 漏了** —— 走只到 json_object 的端點時，它也是 conformsTo 在驗。
    ['PLAN_SCHEMA（規劃對話）', PLAN_SCHEMA],
    ['CANDIDATES_SCHEMA（研究的找候選來源）', CANDIDATES_SCHEMA],
    ['PROBE_SCHEMA（格式探針）', PROBE_SCHEMA],
  ])('%s', (_name, schema) => {
    expect(keywordsOf(schema).size, '一個關鍵字都掃不到代表走訪壞了').toBeGreaterThan(2);
    expect(unsupported(schema)).toEqual([]);
  });

  it('判準認得出清單外的關鍵字 —— 注入一次', () => {
    // 上面四條對現況是綠的。餵幾個 conformsTo 不認得的寫法，確認判準真的會紅，
    // 而且欄位名（properties 底下的 key）不會被誤當成關鍵字。
    const injected = {
      type: 'object',
      properties: {
        pattern: { type: 'string', pattern: '^a' },
        list: { type: 'array', items: { oneOf: [{ type: 'string' }] } },
      },
      additionalProperties: { anyOf: [] },
    };
    expect(unsupported(injected)).toEqual(['anyOf', 'oneOf', 'pattern']);
    expect(
      keywordsOf({ type: 'object', properties: { minItems: { type: 'string' } } }).has('minItems'),
    ).toBe(false);
  });
});
