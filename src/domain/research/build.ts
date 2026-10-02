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
}

export function defaultDecision(candidate: Omit<CandidateDecision, 'decision'>): Decision {
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
