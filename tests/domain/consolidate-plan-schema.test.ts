import { expect, it } from 'vitest';
import { conformsTo, strictify } from '../../src/domain/provider/schema-check.js';
import {
  CONSOLIDATE_PLAN_SCHEMA,
  parseConsolidatePlan,
} from '../../src/domain/research/consolidate.js';

it('受限解碼規格要求每種操作的完整參數，種類與參數不能混用', () => {
  const valid = [
    { kind: 'merge', payload: { keep: 'a', drop: 'b' }, why: '同一對象' },
    { kind: 'extract', payload: { itemIds: ['doc'] }, why: '有正文' },
    { kind: 'retype', payload: { entityId: 'a', to: 'org' }, why: '組織' },
    { kind: 'digest', payload: { itemIds: ['doc'] }, why: '缺少摘要' },
    {
      kind: 'add-edge',
      payload: {
        source: 'a',
        target: 'b',
        rel: '支持',
        itemId: 'doc',
        quote: '這是一段完整的合成引文',
      },
      why: '正文有依據',
    },
  ];
  for (const schema of [CONSOLIDATE_PLAN_SCHEMA, strictify(CONSOLIDATE_PLAN_SCHEMA)]) {
    expect(conformsTo(schema, { operations: valid }).ok).toBe(true);
    for (const operation of valid) {
      expect(conformsTo(schema, { operations: [{ ...operation, payload: {} }] }).ok).toBe(false);
      expect(
        conformsTo(schema, {
          operations: [{ ...operation, payload: { ...operation.payload, unexpected: 1 } }],
        }).ok,
      ).toBe(false);
    }
    expect(
      conformsTo(schema, {
        operations: [{ kind: 'merge', payload: { itemIds: ['doc'] }, why: '錯誤參數' }],
      }).ok,
    ).toBe(false);
  }
  expect(parseConsolidatePlan(JSON.stringify({ operations: valid }))).toHaveLength(5);
});

it('anyOf 仍檢查外層約束與子規格，不接受空或無效分支', () => {
  expect(conformsTo({ anyOf: [] }, 'x').ok).toBe(false);
  expect(conformsTo({ anyOf: [null] }, 'x').ok).toBe(false);
  expect(conformsTo({ type: 'string', maxLength: 2, anyOf: [{ enum: ['long'] }] }, 'long').ok).toBe(
    false,
  );
  expect(
    conformsTo(
      {
        anyOf: [
          { type: 'integer', minimum: 2 },
          { type: 'string', minLength: 2 },
        ],
      },
      1,
    ).ok,
  ).toBe(false);
  expect(
    conformsTo(
      {
        anyOf: [
          { type: 'integer', minimum: 2 },
          { type: 'string', minLength: 2 },
        ],
      },
      'ok',
    ).ok,
  ).toBe(true);
});
