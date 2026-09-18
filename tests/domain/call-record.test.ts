/**
 * 模型呼叫紀錄的形狀與「哪些任務要記」。
 *
 * **這一份守的是一個判斷，不是一段程式**：`embed` 不記。
 * 它很容易在「順手把四個任務都記起來」的時候被改掉，
 * 而那樣會把一串 2560 個浮點數寫進每一個專題資料夾 —— 沒有人看得懂，
 * 而且它會把真正有用的那三種紀錄淹掉。
 */
import { describe, expect, it } from 'vitest';

import {
  endpointOf,
  isLoggedTask,
  LOGGED_MODEL_TASKS,
  toJsonl,
  type ModelCallRecord,
} from '../../src/domain/provider/call-record.js';
import { MODEL_TASKS } from '../../src/domain/provider/capabilities.js';

describe('哪些任務要記', () => {
  it('三個會產生文字的任務都記', () => {
    expect(isLoggedTask('find-sources')).toBe(true);
    expect(isLoggedTask('angles')).toBe(true);
    expect(isLoggedTask('extract')).toBe(true);
  });

  it('embed 不記 —— 它的輸出是一串數字，當文字看沒有意義', () => {
    expect(isLoggedTask('embed')).toBe(false);
  });

  it('清單上的每一個都是真的任務', () => {
    const known = MODEL_TASKS.map((t) => t.task);
    for (const task of LOGGED_MODEL_TASKS) expect(known).toContain(task);
  });
});

describe('端點只留網域', () => {
  it('路徑與查詢參數都不留 —— 有些端點把金鑰放在那裡', () => {
    expect(endpointOf('https://api.example.com/v1?key=secret')).toBe('api.example.com');
  });

  it('帶埠的本機位址留著埠 —— 那是分得出兩台的唯一資訊', () => {
    expect(endpointOf('http://127.0.0.1:11434')).toBe('127.0.0.1:11434');
  });

  it('空的或壞掉的網址回 null，不回一個看起來像網域的東西', () => {
    expect(endpointOf(null)).toBeNull();
    expect(endpointOf('   ')).toBeNull();
    expect(endpointOf('不是網址')).toBeNull();
  });
});

describe('一行一個 JSON', () => {
  const record: ModelCallRecord = {
    at: '2026-09-18T07:00:00.000Z',
    runId: 'run-1',
    correlationId: 'cid-1',
    task: 'extract',
    role: 'chat',
    model: 'qwen3.5:4b',
    transport: 'ollama',
    endpoint: '127.0.0.1:11434',
    itemId: 'item-1',
    request: { system: '系統訊息', user: '第一行\n第二行' },
    response: { text: '{"entities":[]}', errorDetail: null },
    outcome: { ok: true, code: null, elapsedMs: 1234, costUsd: null },
  };

  it('內文裡的換行不會把一筆拆成兩行', () => {
    const line = toJsonl(record);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(line.split('\n').filter((l) => l.length > 0)).toHaveLength(1);
  });

  it('解析回來是同一筆', () => {
    expect(JSON.parse(toJsonl(record))).toEqual(record);
  });

  /** **沒回報就是 `null`，不要填 0** —— 跟 `CallCost` 同一條規矩。 */
  it('沒有金額成本時寫的是 null，不是 0', () => {
    expect((JSON.parse(toJsonl(record)) as ModelCallRecord).outcome.costUsd).toBeNull();
  });
});
