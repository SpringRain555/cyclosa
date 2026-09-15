import { describe, expect, it } from 'vitest';
import {
  actionsFrom,
  EDGE_TRANSITIONS,
  machineMayUpdateStatus,
  mayAdjudicate,
  transition,
} from '../../src/domain/graph/edge-state.js';
import { EDGE_LAYERS } from '../../src/domain/graph/types.js';
import type { EdgeStatus } from '../../src/domain/graph/types.js';

const ALL: EdgeStatus[] = ['pending', 'confirmed', 'rejected'];

describe('關聯狀態機：六條轉移', () => {
  it('轉移表剛好六條', () => {
    expect(EDGE_TRANSITIONS).toHaveLength(6);
  });

  it.each([
    ['pending', 'confirm', 'confirmed'],
    ['pending', 'reject', 'rejected'],
    ['confirmed', 'withdraw', 'pending'],
    ['confirmed', 'reclassify', 'rejected'],
    ['rejected', 'restore', 'pending'],
    ['rejected', 'reclassify', 'confirmed'],
  ] as const)('%s --%s--> %s', (from, action, to) => {
    const r = transition({ from, action, origin: 'human', evidenceCount: 1 });
    expect(r).toEqual({ kind: 'ok', to });
  });

  it('已確認不是終點 —— 撤回與改判都走得通', () => {
    expect([...actionsFrom('confirmed')].sort()).toEqual(['reclassify', 'withdraw']);
  });

  it('不在表上的組合一律非法', () => {
    // confirm 只有從 pending 出發合法
    for (const from of ALL.filter((s) => s !== 'pending')) {
      const r = transition({ from, action: 'confirm', origin: 'human', evidenceCount: 1 });
      expect(r.kind).toBe('invalid-transition');
    }
  });
});

describe('已確認需要出處，除非是人手動建立的', () => {
  it('機器產生的邊沒有出處就不能被確認', () => {
    const r = transition({
      from: 'pending',
      action: 'confirm',
      origin: 'machine',
      evidenceCount: 0,
    });
    expect(r).toEqual({ kind: 'evidence-required' });
  });

  it('機器產生的邊有出處就可以', () => {
    const r = transition({
      from: 'pending',
      action: 'confirm',
      origin: 'machine',
      evidenceCount: 1,
    });
    expect(r).toEqual({ kind: 'ok', to: 'confirmed' });
  });

  it('人手動建立的邊不需要出處 —— 出處就是那個人', () => {
    const r = transition({ from: 'pending', action: 'confirm', origin: 'human', evidenceCount: 0 });
    expect(r).toEqual({ kind: 'ok', to: 'confirmed' });
  });

  it('改判成已確認也受同一條約束', () => {
    expect(
      transition({ from: 'rejected', action: 'reclassify', origin: 'machine', evidenceCount: 0 }),
    ).toEqual({ kind: 'evidence-required' });
  });
});

describe('機器永遠不得覆寫人工判定', () => {
  it('被人碰過的邊，機器不能再改狀態', () => {
    for (const s of ALL) {
      expect(machineMayUpdateStatus(s, true)).toBe(false);
    }
  });

  it('沒有人碰過的待查證邊可以被重跑更新', () => {
    expect(machineMayUpdateStatus('pending', false)).toBe(true);
  });

  it('沒有人碰過但已經是已確認／已否決的，機器仍然不能動', () => {
    expect(machineMayUpdateStatus('confirmed', false)).toBe(false);
    expect(machineMayUpdateStatus('rejected', false)).toBe(false);
  });
});

/**
 * open-questions Q6 的答案（2026-09-08）。
 *
 * **判準不是層別，是「這條邊會不會被重算蓋掉」** ——
 * 所以規則裡有 `origin`，正如 Q6 自己預料的那樣。
 */
describe('哪些邊裁決得動', () => {
  it('機器建的具名關係可以 —— 它就是為了給人判斷才存在的', () => {
    expect(mayAdjudicate({ layer: 'named', origin: 'machine' })).toBe(true);
  });

  it.each(['comention', 'similarity', 'derived'] as const)(
    '機器建的 %s 不行 —— 下次重算會把判斷蓋掉',
    (layer) => {
      expect(mayAdjudicate({ layer, origin: 'machine' })).toBe(false);
    },
  );

  it('**人建的邊每一層都可以** —— 重算永遠不碰人建的列', () => {
    for (const layer of EDGE_LAYERS) {
      expect(mayAdjudicate({ layer, origin: 'human' })).toBe(true);
    }
  });

  /**
   * 這一條不是重複上面兩條 —— 它守的是**理由**。
   * 如果哪天有人把規則簡化成「只有 named 能裁決」，上面那三條仍然全綠，
   * 而這一條會紅：人手動建了一條轉載之後就再也拿不掉它了
   * （api-contract 沒有刪除端點）。
   */
  it('人建錯一條轉載，撤回得動 —— 否則它永遠拿不掉', () => {
    expect(mayAdjudicate({ layer: 'derived', origin: 'human' })).toBe(true);
    expect(actionsFrom('confirmed')).toContain('withdraw');
  });
});
