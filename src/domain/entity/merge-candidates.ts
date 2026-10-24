import { identityKey, surfaceFormsOf, type EntityLike } from './identity.js';

export interface MergeThresholds {
  readonly maxNameDistance: number;
  readonly minSimilarity: number;
}

/** 初始篩選值，尚不是維護者在真實資料上量過的品質保證。 */
export const DEFAULT_MERGE_THRESHOLDS: MergeThresholds = {
  maxNameDistance: 5,
  minSimilarity: 0.97,
};

export function mergeThresholdsOf(raw: unknown): MergeThresholds {
  const row = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const distance = row['maxNameDistance'];
  const similarity = row['minSimilarity'];
  return {
    maxNameDistance:
      typeof distance === 'number' && Number.isInteger(distance) && distance >= 0 && distance <= 100
        ? distance
        : DEFAULT_MERGE_THRESHOLDS.maxNameDistance,
    minSimilarity:
      typeof similarity === 'number' &&
      Number.isFinite(similarity) &&
      similarity >= 0 &&
      similarity <= 1
        ? similarity
        : DEFAULT_MERGE_THRESHOLDS.minSimilarity,
  };
}

/** Unicode 字元的 Levenshtein 距離；超過門檻時提早結束。 */
function distanceOf(a: string, b: string, max: number): number {
  const left = [...a];
  const right = [...b];
  if (Math.abs(left.length - right.length) > max) return max + 1;
  let previous = right.map((_, i) => i + 1);
  previous.unshift(0);
  for (let i = 0; i < left.length; i++) {
    const current = [i + 1];
    for (let j = 0; j < right.length; j++) {
      current.push(
        Math.min(
          (current[j] ?? 0) + 1,
          (previous[j + 1] ?? 0) + 1,
          (previous[j] ?? 0) + (left[i] === right[j] ? 0 : 1),
        ),
      );
    }
    if (Math.min(...current) > max) return max + 1;
    previous = current;
  }
  return previous[right.length] ?? left.length;
}

export interface NamePair {
  readonly left: string;
  readonly right: string;
  readonly nameDistance: number;
}

/** 只篩同型別、未合併的實體；本名、別名與括號寫法都參與第一道門檻。 */
export function nearbyEntityNames(rows: readonly EntityLike[], max: number): readonly NamePair[] {
  const live = rows
    .filter((row) => !row.mergedInto)
    .map((row) => ({
      ...row,
      forms: [...new Set(surfaceFormsOf(row.name, row.aliases).map(identityKey))].filter(
        (s) => [...s].length >= 2,
      ),
    }));
  const pairs: NamePair[] = [];
  for (let i = 0; i < live.length; i++) {
    const a = live[i];
    if (a === undefined) continue;
    for (let j = i + 1; j < live.length; j++) {
      const b = live[j];
      if (b === undefined || a.type !== b.type) continue;
      let distance = max + 1;
      for (const left of a.forms)
        for (const right of b.forms) {
          distance = Math.min(distance, distanceOf(left, right, max));
        }
      if (distance <= max) pairs.push({ left: a.id, right: b.id, nameDistance: distance });
    }
  }
  return pairs;
}

/** 無效、零向量或不同維度都不可成為「低相似度」的假答案。 */
export function cosineOf(a: Float32Array, b: Float32Array): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? NaN,
      y = b[i] ?? NaN;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))) : null;
}

export function mergePairKey(a: string, b: string): string {
  return JSON.stringify([a, b].sort());
}
