import { describe, expect, it } from 'vitest';
import {
  actionsFrom,
  EDGE_TRANSITIONS,
  machineMayUpdateStatus,
  transition,
} from '../../src/domain/graph/edge-state.js';
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
