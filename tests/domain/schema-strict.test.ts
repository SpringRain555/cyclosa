/**
 * `strictify`：把 schema 改成 OpenAI 的 `strict: true` 收得下的形狀。
 *
 * **這一份守的是一個 2026-09-18 真的踩到的洞。** 那天第一次有機會對著一個
 * 線上端點跑（使用者給了一把第三方代理的金鑰），結果是：
 *
 * - 格式量測說「這個端點支援 `json_schema`」（探針那份 schema 有 `additionalProperties: false`）
 * - 接著每一次真的呼叫都 **HTTP 400**：`'additionalProperties' is required to be supplied and to be false`
 * - 而錯誤訊息說的是「量的時候還支援，去重新檢查」—— **把我們自己的 schema 問題講成對方改了規格**
 *
 * 三份真的 schema（角度、抽取、找來源）一份都沒有寫 `additionalProperties`。
 * 也就是說 v0.18.0 宣稱的「可以接任何 OpenAI 相容端點」，
 * **對嚴格模式的端點從來沒有成立過** —— 因為在那之前一個線上端點都沒量過。
 */
import { describe, expect, it } from 'vitest';

import { conformsTo, strictify } from '../../src/domain/provider/schema-check.js';
import {
  ANGLES_SCHEMA,
  EXTRACT_SCHEMA,
  SOURCES_SCHEMA,
} from '../../src/application/expansion-prompts.js';
import { CANDIDATES_SCHEMA, PLAN_SCHEMA } from '../../src/application/research-prompts.js';

type Node = Readonly<Record<string, unknown>>;

/**
 * OpenAI 嚴格模式的兩條要求，遞迴檢查：
 * 每個物件節點都要 `additionalProperties: false`，而且 `required` 要列出全部屬性。
 */
function violations(schema: Node, path = '$'): string[] {
  const out: string[] = [];
  if (schema['type'] === 'object') {
    const props = (schema['properties'] ?? {}) as Record<string, unknown>;
    if (schema['additionalProperties'] !== false) out.push(`${path} 少了 additionalProperties`);
    const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
    for (const key of Object.keys(props)) {
      if (!required.includes(key)) out.push(`${path}.${key} 不在 required 裡`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (typeof sub === 'object' && sub !== null)
        out.push(...violations(sub as Node, `${path}.${key}`));
    }
  }
  const items = schema['items'];
  if (typeof items === 'object' && items !== null)
    out.push(...violations(items as Node, `${path}[]`));
  return out;
}

const REAL_SCHEMAS = [
  ['角度', ANGLES_SCHEMA],
  ['抽取', EXTRACT_SCHEMA],
  ['找來源', SOURCES_SCHEMA],
  // 研究的兩份（Stage 19／20）。**規劃那一份 Stage 19 漏了** —— 它走 OpenAI 相容 API 的時候
  // 一樣會被嚴格模式檢查。
  ['規劃', PLAN_SCHEMA],
  ['研究的候選', CANDIDATES_SCHEMA],
] as const;

describe('三份真的 schema 直接送出去會被嚴格模式擋下來', () => {
  it.each(REAL_SCHEMAS)('%s：原樣不合格（這就是那個洞）', (_name, schema) => {
    expect(violations(schema as Node).length).toBeGreaterThan(0);
  });

  it.each(REAL_SCHEMAS)('%s：strictify 之後完全合格', (_name, schema) => {
    expect(violations(strictify(schema as Node))).toEqual([]);
  });

  /**
   * **`required` 那一半目前是恆等的**，而這一條就是在守那句話 ——
   * 有人加一個「選填」欄位的那一天，這裡會紅，
   * 而那正是需要有人決定「要嘛列進 required、要嘛改成可為 null」的時候。
   */
  it.each(REAL_SCHEMAS)(
    '%s：strictify 只補 additionalProperties，不動 required',
    (_name, schema) => {
      const before = JSON.stringify((schema as Node)['required']);
      const after = JSON.stringify(strictify(schema as Node)['required']);
      expect(after).toBe(before);
    },
  );
});

describe('strictify 本身', () => {
  const nested = {
    type: 'object',
    properties: {
      list: {
        type: 'array',
        items: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
      },
      inner: { type: 'object', properties: { b: { type: 'integer' } }, required: ['b'] },
    },
    required: ['list', 'inner'],
  } as const;

  it('陣列裡面的物件也補得到', () => {
    const out = strictify(nested);
    const items = ((out['properties'] as Node)['list'] as Node)['items'] as Node;
    expect(items['additionalProperties']).toBe(false);
  });

  it('巢狀的物件也補得到', () => {
    const inner = (strictify(nested)['properties'] as Node)['inner'] as Node;
    expect(inner['additionalProperties']).toBe(false);
  });

  it('不動原本那一份 —— conformsTo 用的仍然是寬鬆的那一份', () => {
    const copy = JSON.stringify(nested);
    strictify(nested);
    expect(JSON.stringify(nested)).toBe(copy);
  });

  /**
   * **這是「改在邊界」的理由**：本機那條路多一個欄位照樣過，
   * 而嚴格模式那條路多一個欄位會被端點擋下來。兩邊本來就不同，不該被合成一種。
   */
  it('原本的 schema 仍然容得下多出來的欄位，strictify 過的不容', () => {
    const value = { list: [{ a: 'x' }], inner: { b: 1 }, extra: '多出來的' };
    expect(conformsTo(nested, value).ok).toBe(true);
    expect(conformsTo(strictify(nested), value).ok).toBe(false);
  });

  it('非物件的節點原樣帶過去', () => {
    const out = strictify({ type: 'array', items: { type: 'string' } });
    expect(out).toEqual({ type: 'array', items: { type: 'string' } });
  });
});
