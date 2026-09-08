import { describe, expect, it } from 'vitest';
import {
  angleOutcome,
  nextItemStatus,
  nextRunStatus,
  producedUsableOutput,
  settleAngles,
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

/**
 * **一條切入角度有三種結局，不是兩種**（Stage 9）。
 *
 * 這一組測試來自一次真的跑出來的結果：agent 找到 6 個學術來源、
 * 5 個是付費牆、剩下那一個寫進了 1 個節點與 9 條關聯，
 * 而模型給的引文有幾條在原文裡找不到。
 * **第一版把它標成「失敗」** —— 而畫面上同時列著它寫進去的東西。
 */
describe('切入角度的三種結局', () => {
  it('沒有碼就是乾淨的', () => {
    expect(angleOutcome({ code: null, fatal: false, produced: true })).toBe('clean');
  });

  it('**有碼但做出了東西 ＝ 只做成一部分，不是失敗**', () => {
    expect(angleOutcome({ code: 'PROVIDER_QUOTE_NOT_FOUND', fatal: false, produced: true })).toBe(
      'degraded',
    );
  });

  it('有碼而且什麼都沒做出來才是失敗', () => {
    expect(angleOutcome({ code: 'PROVIDER_TIMEOUT', fatal: false, produced: false })).toBe(
      'failed',
    );
  });

  /** `error` 級的碼要整批停下來 —— 已經寫進去的東西不會因此消失，但這一條是失敗。 */
  it('`error` 級的碼一律是失敗，即使做出了東西', () => {
    expect(angleOutcome({ code: 'PROVIDER_SANDBOX_VIOLATION', fatal: true, produced: true })).toBe(
      'failed',
    );
  });

  it('全部乾淨 → 已完成', () => {
    expect(settleAngles(['clean', 'clean'])).toBe('complete');
  });

  /** **這一條就是那次驗收抓到的東西。** */
  it('一條角度做出了東西但有碼 → 部分失敗，不是失敗', () => {
    expect(settleAngles(['degraded'])).toBe('complete-partial');
  });

  it('有乾淨的也有失敗的 → 部分失敗', () => {
    expect(settleAngles(['clean', 'failed'])).toBe('complete-partial');
  });

  it('一條都沒做出東西才是失敗', () => {
    expect(settleAngles(['failed', 'failed'])).toBe('fail');
  });

  /**
   * **這條路走不到** —— `chooseAngles` 對空選擇回 `EXPORT_EMPTY_SELECTION`。
   * 釘住它只是為了讓「`every` 對空陣列回 true」這件事是被寫下來的，
   * 而不是下一個人讀這支函式時要自己想一遍。
   */
  it('空陣列回 complete（呼叫端擋在前面，所以走不到這裡）', () => {
    expect(settleAngles([])).toBe('complete');
  });
});
