/**
 * CLI 回 `is_error` 的時候，**這次失敗是哪一種、它自己說了什麼**（2026-10-28）。
 *
 * 之前一律記成 `PROVIDER_BUDGET_EXCEEDED`，連模型名稱打錯也是，而 CLI 那一句被丟掉 ——
 * 試用時「規劃」整條失敗，畫面只寫「這一輪沒有交出可以用的規劃」。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  classifyFailure,
  createClaudeAgent,
  FAILURE_DETAIL_CHARS,
  parseStreamJson,
} from '../../src/infrastructure/providers/agent-claude.js';

const MODEL_MISSING =
  "There's an issue with the selected model (no-such-model-cyclosa-probe). It may not exist or you may not have access to it. Run --model to pick a different model.";

/**
 * 真樣本的 `result` 事件（CLI 2.1.116，2026-10-28 錄；`--model` 給不存在的名字，API 回 404）。
 * **`subtype` 是 `success`，`is_error` 是 `true`** —— 只看 `subtype` 會把它當成功。
 * 識別碼換成 `<x>`，其餘欄位照錄。
 */
const modelMissing = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  api_error_status: 404,
  duration_ms: 677,
  num_turns: 1,
  result: MODEL_MISSING,
  stop_reason: 'stop_sequence',
  session_id: '<x>',
  total_cost_usd: 0.000406,
  terminal_reason: 'completed',
  uuid: '<x>',
};

function line(event: unknown): string {
  return JSON.stringify(event);
}

describe('parseStreamJson 的失敗那一面', () => {
  it('subtype 說成功、is_error 說失敗：算失敗，而且留下 CLI 說的那一句', () => {
    const summary = parseStreamJson([line(modelMissing)]);
    expect(summary.isError).toBe(true);
    expect(summary.subtype).toBe('success');
    expect(summary.errorText).toBe(MODEL_MISSING);
  });

  it('成功的那一次沒有 errorText', () => {
    const summary = parseStreamJson([
      line({ type: 'result', subtype: 'success', is_error: false, result: '{"ok":true}' }),
    ]);
    expect(summary.isError).toBe(false);
    expect(summary.errorText).toBeNull();
  });

  it('error_ 開頭的 subtype 就算沒帶 is_error 也是失敗', () => {
    const summary = parseStreamJson([line({ type: 'result', subtype: 'error_during_execution' })]);
    expect(summary.isError).toBe(true);
    expect(summary.errorText).toBeNull();
  });

  it('result 是空的時候拿 errors 陣列', () => {
    const summary = parseStreamJson([
      line({ type: 'result', subtype: 'error_during_execution', errors: ['甲', 7, '乙'] }),
    ]);
    expect(summary.errorText).toBe('甲；乙');
  });
});

describe('classifyFailure', () => {
  it('模型不存在 → 請求被拒，細節是 CLI 自己那一句', () => {
    expect(classifyFailure(parseStreamJson([line(modelMissing)]), '')).toEqual({
      code: 'PROVIDER_REQUEST_REJECTED',
      detail: MODEL_MISSING,
    });
  });

  it('撞到 provider 的用量限制 → 用量上限，細節說哪一種限制、何時重置', () => {
    const summary = parseStreamJson([
      line({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1792216800 },
      }),
      line({ type: 'result', subtype: 'success', is_error: true, result: 'limit reached' }),
    ]);
    expect(classifyFailure(summary, '')).toEqual({
      code: 'PROVIDER_BUDGET_EXCEEDED',
      detail: '用量限制 five_hour，重置於 2026-10-17T06:00:00.000Z',
    });
  });

  it('預算與回合數到了 → 用量上限', () => {
    for (const subtype of ['error_max_budget_usd', 'error_max_turns']) {
      const summary = parseStreamJson([line({ type: 'result', subtype, is_error: true })]);
      expect(classifyFailure(summary, 'stderr 那一句').code).toBe('PROVIDER_BUDGET_EXCEEDED');
      expect(classifyFailure(summary, 'stderr 那一句').detail).toBe('stderr 那一句');
    }
  });

  it('CLI 什麼都沒說的時候退回 stderr', () => {
    const summary = parseStreamJson([line({ type: 'result', subtype: 'success', is_error: true })]);
    expect(classifyFailure(summary, '  something broke \n')).toEqual({
      code: 'PROVIDER_REQUEST_REJECTED',
      detail: 'something broke',
    });
  });

  it('細節有上限', () => {
    const long = 'x'.repeat(FAILURE_DETAIL_CHARS * 2);
    const summary = parseStreamJson([
      line({ type: 'result', subtype: 'success', is_error: true, result: long }),
    ]);
    expect(classifyFailure(summary, '').detail).toHaveLength(FAILURE_DETAIL_CHARS);
  });
});

it('接在 run() 上：模型不存在的那一次回請求被拒與那一句，不是用量上限', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'claude-failure-'));
  try {
    const script = join(folder, 'fake.cjs');
    await writeFile(script, `console.log(${JSON.stringify(line(modelMissing))});`, 'utf8');
    const agent = createClaudeAgent({
      command: process.execPath,
      args: [script],
      model: 'no-such-model-cyclosa-probe',
      systemPrompt: 'fixture',
      schema: {},
      maxCostUsd: null,
      tools: 'none',
    });
    const result = await agent.run({ prompt: 'fixture', cwd: folder, timeoutMs: 5000 });
    expect(result).toMatchObject({
      kind: 'error',
      code: 'PROVIDER_REQUEST_REJECTED',
      detail: MODEL_MISSING,
    });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
