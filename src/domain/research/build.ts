import type { Relevance } from '../provider/digest.js';
import { FINAL_DIGEST_CODES, type Acquisition } from './collect.js';
import type { ResearchStatus } from './index.js';

export const DECISIONS = ['include', 'reference', 'discard'] as const;
export type Decision = (typeof DECISIONS)[number];
export type BuildState = 'done' | 'failed';

export interface CandidateDecision {
  readonly acquisition: Acquisition;
  readonly relevance: Relevance | null;
  readonly digestCode: string | null;
  readonly decision: Decision | null;
  /**
   * 可能跟專題裡已有的、或這次另一個候選是同一篇（`duplicates.ts`，2026-10-28 試用回饋 8）。
   * **預設不進圖**：同一篇抽兩次，圖上就有兩個節點講同一件事。這是預設，人可以改。
   */
  readonly duplicate?: boolean;
}

export function defaultDecision(candidate: Omit<CandidateDecision, 'decision'>): Decision {
  if (candidate.duplicate === true) return 'discard';
  if (candidate.acquisition !== 'fetched' && candidate.acquisition !== 'uploaded') {
    return 'reference';
  }
  if (candidate.relevance === 'no') return 'discard';
  if (candidate.relevance !== null) return 'include';
  return candidate.digestCode !== null && FINAL_DIGEST_CODES.includes(candidate.digestCode)
    ? 'reference'
    : 'include';
}

export function effectiveDecision(candidate: CandidateDecision): Decision {
  return candidate.decision ?? defaultDecision(candidate);
}

export function mayStartBuilding(
  status: ResearchStatus,
  decisions: readonly (Decision | null)[],
): boolean {
  return status === 'reviewing' && decisions.every((decision) => decision !== null);
}

export function statusAfterBuildRun(
  reason: 'completed' | 'cancelled' | 'interrupted',
): ResearchStatus {
  return reason === 'completed' ? 'done' : 'building';
}

export function mayResumeBuilding(status: ResearchStatus, live: boolean): boolean {
  return status === 'building' && !live;
}

export function mayFinishBuilding(
  status: ResearchStatus,
  live: boolean,
  reason: 'completed' | 'cancelled' | 'interrupted',
): boolean {
  return status === 'building' && !live && reason === 'cancelled';
}
