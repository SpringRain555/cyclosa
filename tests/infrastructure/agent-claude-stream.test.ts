import { describe, expect, it } from 'vitest';

import {
  parseStreamJson,
  rateLimitDetail,
  rateLimitLog,
  type RateLimitInfo,
} from '../../src/infrastructure/providers/agent-claude.js';

const sample = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    resetsAt: 1792216800,
    rateLimitType: 'seven_day',
    utilization: 0.89,
    isUsingOverage: false,
    surpassedThreshold: 0.75,
  },
  uuid: '<x>',
  session_id: '<x>',
};

function event(rateLimitInfo: unknown): string {
  return JSON.stringify({ type: 'rate_limit_event', rate_limit_info: rateLimitInfo });
}

describe('parseStreamJson 的 rate_limit_event', () => {
  it('從官方事件的 rate_limit_info 讀取欄位', () => {
    expect(parseStreamJson([JSON.stringify(sample)]).rateLimit).toEqual({
      status: 'allowed_warning',
      type: 'seven_day',
      resetsAt: 1792216800,
      utilization: 0.89,
    });
  });

  it('保留 allowed 狀態', () => {
    expect(
      parseStreamJson([event({ status: 'allowed', rateLimitType: 'five_hour' })]).rateLimit,
    ).toEqual({ status: 'allowed', type: 'five_hour', resetsAt: null, utilization: null });
  });

  it('保留 rejected 狀態', () => {
    expect(
      parseStreamJson([
        event({ status: 'rejected', rateLimitType: 'seven_day', resetsAt: 1792216800 }),
      ]).rateLimit,
    ).toEqual({
      status: 'rejected',
      type: 'seven_day',
      resetsAt: 1792216800,
      utilization: null,
    });
  });

  it('缺欄位或欄位型別錯誤時以 null 表示', () => {
    expect(
      parseStreamJson([
        event({ status: 'allowed_warning', rateLimitType: 7, resetsAt: 'later', utilization: {} }),
      ]).rateLimit,
    ).toEqual({ status: 'allowed_warning', type: null, resetsAt: null, utilization: null });
  });

  it('rate_limit_info 不是物件時忽略事件', () => {
    expect(parseStreamJson([event('allowed_warning')]).rateLimit).toBeNull();
    expect(parseStreamJson([event(null)]).rateLimit).toBeNull();
    expect(parseStreamJson([event(['allowed_warning'])]).rateLimit).toBeNull();
  });

  it('status 缺或不是字串時忽略事件 —— 不知道有沒有撞到，就不說撞到了', () => {
    expect(parseStreamJson([event({ rateLimitType: 'seven_day' })]).rateLimit).toBeNull();
    expect(
      parseStreamJson([event({ status: 1, rateLimitType: 'seven_day' })]).rateLimit,
    ).toBeNull();
  });

  it('同一次呼叫保留最後一個有效事件', () => {
    expect(
      parseStreamJson([
        event({ status: 'allowed', rateLimitType: 'five_hour' }),
        event({ status: 'rejected', rateLimitType: 'seven_day' }),
      ]).rateLimit,
    ).toEqual({ status: 'rejected', type: 'seven_day', resetsAt: null, utilization: null });
  });

  it('照舊略過壞掉的 JSON 行', () => {
    expect(
      parseStreamJson(['{not json', event({ status: 'allowed', rateLimitType: 'five_hour' })])
        .rateLimit,
    ).toEqual({ status: 'allowed', type: 'five_hour', resetsAt: null, utilization: null });
  });
});

describe('rate limit 日誌與錯誤細節', () => {
  const info: RateLimitInfo = {
    status: 'allowed_warning',
    type: 'seven_day',
    resetsAt: 1792216800,
    utilization: 0.89,
  };

  it('allowed 不寫日誌，也不提供限制錯誤細節', () => {
    expect(rateLimitLog({ ...info, status: 'allowed' })).toBeNull();
    expect(rateLimitDetail({ ...info, status: 'allowed' })).toBeNull();
  });

  it('allowed_warning 用 info，並把重置時間寫成 ISO', () => {
    expect(rateLimitLog(info)).toEqual({
      level: 'info',
      msg: 'Claude Code 的用量接近上限',
      fields: {
        type: 'seven_day',
        utilization: 0.89,
        resetsAt: '2026-10-17T06:00:00.000Z',
      },
    });
    expect(rateLimitDetail(info)).toBeNull();
  });

  it('rejected 用 warn，並提供用量限制細節', () => {
    const rejected = { ...info, status: 'rejected' };
    expect(rateLimitLog(rejected)).toEqual({
      level: 'warn',
      msg: 'agent 撞到 provider 自己的用量限制',
      fields: {
        status: 'rejected',
        type: 'seven_day',
        utilization: 0.89,
        resetsAt: '2026-10-17T06:00:00.000Z',
      },
    });
    expect(rateLimitDetail(rejected)).toBe('用量限制 seven_day，重置於 2026-10-17T06:00:00.000Z');
  });

  it('未知狀態視為警告；沒有重置時間時日誌保留 null', () => {
    const unexpected = { ...info, status: 'future_status', resetsAt: null };
    expect(rateLimitLog(unexpected)).toEqual({
      level: 'warn',
      msg: 'agent 撞到 provider 自己的用量限制',
      fields: {
        status: 'future_status',
        type: 'seven_day',
        utilization: 0.89,
        resetsAt: null,
      },
    });
    expect(rateLimitDetail(unexpected)).toBeNull();
  });
});
