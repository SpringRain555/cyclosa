/**
 * `conformsTo` —— 端點不保證形狀時，**同一個性質改由它保證**。
 *
 * 它守的是 `expansion-prompts.ts` 檔頭三層防護的第二層：
 * 能通過的只有實體與關係。所以這裡測的重點是**拒絕**，不是接受 ——
 * 一支會接受錯形狀的驗證器，比沒有驗證器更糟：它讓那份輸出看起來被檢查過了。
 */
import { describe, expect, it } from 'vitest';

import { conformsTo } from '../../src/domain/provider/index.js';
import {
  ANGLES_SCHEMA,
  EXTRACT_SCHEMA,
  SOURCES_SCHEMA,
} from '../../src/application/expansion-prompts.js';

const PROBE = {
  type: 'object',
  properties: {
    probe: { type: 'string', enum: ['cyclosa-json-schema-probe'] },
    n: { type: 'integer', minimum: 7, maximum: 7 },
  },
  required: ['probe', 'n'],
  additionalProperties: false,
} as const;

describe('conformsTo', () => {
  it('符合的過', () => {
    expect(conformsTo(PROBE, { probe: 'cyclosa-json-schema-probe', n: 7 })).toEqual({ ok: true });
  });

  it.each([
    ['少一個必要欄位', { probe: 'cyclosa-json-schema-probe' }, '$.n'],
    ['多一個欄位', { probe: 'cyclosa-json-schema-probe', n: 7, extra: 1 }, '$.extra'],
    ['enum 以外的值', { probe: 'something-else', n: 7 }, '$.probe'],
    ['整數寫成小數', { probe: 'cyclosa-json-schema-probe', n: 7.5 }, '$.n'],
    ['超出範圍', { probe: 'cyclosa-json-schema-probe', n: 8 }, '$.n'],
    ['型別不對', { probe: 7, n: 7 }, '$.probe'],
  ])('%s → 不過，而且指得出是哪裡', (_why, value, path) => {
    const r = conformsTo(PROBE, value);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.path).toBe(path);
  });

  it('不是物件的東西不會被當成空物件放行', () => {
    for (const value of [null, [], 'x', 7]) {
      expect(conformsTo(PROBE, value).ok, JSON.stringify(value)).toBe(false);
    }
  });

  /**
   * **不認得的關鍵字一律不通過。** 略過它的意思是「那一條限制沒有被檢查，
   * 而結果寫著通過」—— 一條 `pattern` 限制會安靜地失效。
   */
  it('schema 用了不支援的關鍵字 → 不通過，不是略過', () => {
    const r = conformsTo({ type: 'string', pattern: '^a$' }, 'b');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('pattern');
  });

  it('description 與 title 是註記，不是限制', () => {
    expect(conformsTo({ type: 'string', description: '說明', title: '標題' }, 'x')).toEqual({
      ok: true,
    });
  });

  /**
   * 長度用**碼位**算。JSON Schema 規定的是碼位，而 JS 的 `length` 是 UTF-16 單位 ——
   * 一個 emoji 在後者算 2。用錯的話，一段剛好在上限的引文會被多擋下來。
   */
  it('字串長度用碼位算，不是 UTF-16 單位', () => {
    expect(conformsTo({ type: 'string', maxLength: 2 }, '😀😀').ok).toBe(true);
    expect(conformsTo({ type: 'string', maxLength: 2 }, '😀😀😀').ok).toBe(false);
  });

  it('陣列的上界與每一項都檢查', () => {
    const schema = { type: 'array', maxItems: 2, items: { type: 'integer' } };
    expect(conformsTo(schema, [1, 2]).ok).toBe(true);
    expect(conformsTo(schema, [1, 2, 3]).ok).toBe(false);
    const r = conformsTo(schema, [1, 'x']);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.path).toBe('$[1]');
  });
});

/**
 * **三份真的會送出去的 schema，每一份都驗得了。**
 *
 * 用一份最小的合法輸出跑過去 —— 如果哪一份用了這支不支援的關鍵字，
 * 這裡會拿到「不支援」而不是 `ok`，那條路在事後驗證模式下就會永遠失敗。
 */
describe('三份擴展用的 schema', () => {
  it('ANGLES：空清單是合法的形狀', () => {
    expect(conformsTo(ANGLES_SCHEMA, { angles: [] })).toEqual({ ok: true });
  });

  it('ANGLES：一條多出 maxLength 的子問題會被擋下來', () => {
    const long = '問'.repeat(10_000);
    const r = conformsTo(ANGLES_SCHEMA, {
      angles: [{ question: long, stance: 'x', seeds: [] }],
    });
    expect(r.ok).toBe(false);
  });

  it('SOURCES 與 EXTRACT：最小輸出是合法的形狀', () => {
    const sourcesMin = Object.fromEntries(
      ((SOURCES_SCHEMA as { required?: readonly string[] }).required ?? []).map((k) => [k, []]),
    );
    const extractMin = Object.fromEntries(
      ((EXTRACT_SCHEMA as { required?: readonly string[] }).required ?? []).map((k) => [k, []]),
    );
    expect(conformsTo(SOURCES_SCHEMA, sourcesMin)).toEqual({ ok: true });
    expect(conformsTo(EXTRACT_SCHEMA, extractMin)).toEqual({ ok: true });
  });

  /**
   * **注入：一份抓回來的網頁想讓模型回一個「動作」。**
   *
   * 那正是第二層防護要擋的形狀。端點不保證 schema 的時候，
   * 這一支是唯一擋得住它的地方。
   */
  it('EXTRACT：夾帶一個不在 schema 裡的形狀 → 擋下來', () => {
    const required = (EXTRACT_SCHEMA as { required?: readonly string[] }).required ?? [];
    const base = Object.fromEntries(required.map((k) => [k, []]));
    const entities = { ...base, entities: [{ action: 'confirm-all-edges' }] };
    expect(conformsTo(EXTRACT_SCHEMA, entities).ok).toBe(false);
  });
});
