import { conformsTo } from '../provider/schema-check.js';

export const GAP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    opinion: { type: 'string', minLength: 1, maxLength: 12000 },
  },
  required: ['opinion'],
} as const;

export interface GapAssessment {
  readonly opinion: string;
  readonly model: string;
  readonly costUsd: number | null;
  readonly at: number;
}

export function parseGapOpinion(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!conformsTo(GAP_SCHEMA, value).ok) return null;
    const opinion = (value as { opinion: string }).opinion.trim();
    return opinion.length > 0 ? opinion : null;
  } catch {
    return null;
  }
}

export function gapOf(raw: string | null): GapAssessment | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as GapAssessment;
    if (
      typeof value.opinion !== 'string' ||
      typeof value.model !== 'string' ||
      typeof value.at !== 'number' ||
      (value.costUsd !== null && typeof value.costUsd !== 'number')
    )
      return null;
    return value;
  } catch {
    return null;
  }
}
