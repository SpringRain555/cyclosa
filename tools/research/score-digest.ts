/**
 * 初讀（digest）量測的計分 —— **純函式**，給 `measure-digest.ts` 用，判準在
 * `docs/research/digest-measurement.md`。數字怎麼算寫在那一份，這裡只是把它變成程式；
 * 改這裡的算法等於改判準，要先改文件。
 */
import type { Relevance } from '../../src/domain/provider/digest.js';

export type Group = 'main' | 'control';

/** 一份資料、一個模型、一輪的結果 */
export interface DigestRow {
  readonly itemId: string;
  readonly group: Group;
  readonly model: string;
  readonly round: number;
  /** 這個模型這一輪的第一份（含載入模型的時間）—— 中位數不算它 */
  readonly cold: boolean;
  /** 呼叫成功且 `normalizeDigest` 沒回 `null` */
  readonly schemaValid: boolean;
  readonly relevance: Relevance | null;
  readonly titleZhOk: boolean | null;
  readonly summaryLe3: boolean | null;
  readonly seconds: number | null;
  readonly code: string | null;
}

export interface RoundScore {
  readonly model: string;
  readonly round: number;
  readonly n: number;
  readonly schemaValid: number;
  /** 有 gold 的份數（正確率的分母） */
  readonly scored: number;
  readonly exact: number;
  readonly accuracy: number | null;
  /** gold `yes` 判成 `no`、gold `no` 判成 `yes` */
  readonly inversions: number;
  readonly unsureCount: number;
  readonly unsureRate: number | null;
  readonly controlN: number;
  readonly controlNo: number;
  readonly controlAllNo: boolean | null;
  readonly medianSeconds: number | null;
  readonly coldSeconds: number | null;
  readonly titleZhOk: number;
  readonly summaryLe3: number;
}

export function hasCjk(text: string): boolean {
  return /[㐀-鿿]/.test(text);
}

/** 以 。！？!? 斷句數算句數；空字串是 0 句 */
export function sentenceCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  const parts = trimmed.split(/[。！？!?]+/).filter((part) => part.trim().length > 0);
  return Math.max(1, parts.length);
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 多數類基準線：每一份都判成 gold 裡最多的那個值 */
export function majorityBaseline(
  gold: ReadonlyMap<string, Relevance>,
): { readonly label: Relevance; readonly accuracy: number } | null {
  if (gold.size === 0) return null;
  const counts = new Map<Relevance, number>();
  for (const value of gold.values()) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best: { label: Relevance; count: number } | null = null;
  for (const [label, count] of counts) {
    if (best === null || count > best.count) best = { label, count };
  }
  return best === null ? null : { label: best.label, accuracy: best.count / gold.size };
}

export function goldUnsureRate(gold: ReadonlyMap<string, Relevance>): number | null {
  if (gold.size === 0) return null;
  let unsure = 0;
  for (const value of gold.values()) if (value === 'unsure') unsure += 1;
  return unsure / gold.size;
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

export function scoreRound(
  rows: readonly DigestRow[],
  gold: ReadonlyMap<string, Relevance>,
): RoundScore {
  const first = rows[0];
  const model = first?.model ?? '';
  const round = first?.round ?? 0;
  let schemaValid = 0;
  let scored = 0;
  let exact = 0;
  let inversions = 0;
  let unsureCount = 0;
  let controlN = 0;
  let controlNo = 0;
  let titleZhOk = 0;
  let summaryLe3 = 0;
  const warm: number[] = [];
  let coldSeconds: number | null = null;

  for (const row of rows) {
    if (row.schemaValid) schemaValid += 1;
    if (row.relevance === 'unsure') unsureCount += 1;
    if (row.titleZhOk === true) titleZhOk += 1;
    if (row.summaryLe3 === true) summaryLe3 += 1;
    if (row.seconds !== null) {
      if (row.cold) coldSeconds = row.seconds;
      else warm.push(row.seconds);
    }
    if (row.group === 'control') {
      controlN += 1;
      if (row.relevance === 'no') controlNo += 1;
    }
    const expected = gold.get(row.itemId);
    if (expected === undefined) continue;
    scored += 1;
    if (row.relevance === expected) exact += 1;
    if (
      (expected === 'yes' && row.relevance === 'no') ||
      (expected === 'no' && row.relevance === 'yes')
    ) {
      inversions += 1;
    }
  }

  return {
    model,
    round,
    n: rows.length,
    schemaValid,
    scored,
    exact,
    accuracy: ratio(exact, scored),
    inversions,
    unsureCount,
    unsureRate: ratio(unsureCount, rows.length),
    controlN,
    controlNo,
    controlAllNo: controlN === 0 ? null : controlNo === controlN,
    medianSeconds: median(warm),
    coldSeconds,
    titleZhOk,
    summaryLe3,
  };
}

/** 同一份兩輪的 `relevance` 相同的份數（兩輪都有結果的才算） */
export function agreement(
  a: readonly DigestRow[],
  b: readonly DigestRow[],
): { readonly same: number; readonly of: number } {
  const byId = new Map(b.map((row) => [row.itemId, row.relevance]));
  let same = 0;
  let of = 0;
  for (const row of a) {
    const other = byId.get(row.itemId);
    if (row.relevance === null || other === null || other === undefined) continue;
    of += 1;
    if (row.relevance === other) same += 1;
  }
  return { same, of };
}
