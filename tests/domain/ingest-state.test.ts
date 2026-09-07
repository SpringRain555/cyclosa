import { describe, expect, it } from 'vitest';
import {
  nextItemStatus,
  nextRunStatus,
  producedUsableOutput,
  settleRun,
} from '../../src/domain/ingest/state.js';

describe('資料節點的狀態機', () => {
  it('走完整條管線', () => {
    expect(nextItemStatus('pending', 'fetched', 'machine')).toBe('fetched');
    expect(nextItemStatus('fetched', 'parsed', 'machine')).toBe('parsed');
    expect(nextItemStatus('parsed', 'include', 'machine')).toBe('included');
  });

  it('**「已排除」只由人設定，機器不會自己排除任何東西**', () => {
    for (const from of ['pending', 'fetched', 'parsed', 'included'] as const) {
      expect(nextItemStatus(from, 'exclude', 'human')).toBe('excluded');
      expect(nextItemStatus(from, 'exclude', 'machine')).toBeNull();
    }
  });

  it('復原也只有人能做', () => {
    expect(nextItemStatus('excluded', 'restore', 'human')).toBe('pending');
    expect(nextItemStatus('excluded', 'restore', 'machine')).toBeNull();
  });

  it('失敗可以重試，而重試回到待處理（不產生第二個節點）', () => {
    expect(nextItemStatus('pending', 'fail', 'machine')).toBe('failed');
    expect(nextItemStatus('failed', 'retry', 'machine')).toBe('pending');
  });

  it('不在表上的組合一律 null', () => {
    expect(nextItemStatus('included', 'fetched', 'machine')).toBeNull();
    expect(nextItemStatus('excluded', 'include', 'human')).toBeNull();
  });
});

describe('擴展作業的狀態機', () => {
  it('正常走完', () => {
    expect(nextRunStatus('queued', 'start')).toBe('running');
    expect(nextRunStatus('running', 'complete')).toBe('done');
  });

  it('還沒開始也可以取消', () => {
    expect(nextRunStatus('queued', 'cancel')).toBe('cancelled');
  });

  it('終態不能再轉移', () => {
    for (const s of ['done', 'partial', 'cancelled', 'failed'] as const) {
      expect(nextRunStatus(s, 'start')).toBeNull();
      expect(nextRunStatus(s, 'cancel')).toBeNull();
    }
  });
});

describe('部分失敗是一等公民', () => {
  it('40 個 URL 有 3 個 404 → partial，不是 failed', () => {
    expect(settleRun(37, 3)).toBe('complete-partial');
  });

  it('全成功 → done', () => {
    expect(settleRun(40, 0)).toBe('complete');
  });

  it('**一個都沒成功才是 failed**', () => {
    expect(settleRun(0, 40)).toBe('fail');
  });

  it('partial 與 cancelled 都有可用的產出 —— 已寫入的保留', () => {
    expect(producedUsableOutput('partial')).toBe(true);
    expect(producedUsableOutput('cancelled')).toBe(true);
    expect(producedUsableOutput('done')).toBe(true);
  });

  it('只有 failed 沒有產出', () => {
    expect(producedUsableOutput('failed')).toBe(false);
  });
});
