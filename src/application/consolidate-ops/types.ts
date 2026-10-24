import type { ConsolidateOpKind } from '../../domain/research/consolidate.js';
import type { AppliedExtraction } from '../extraction-service.js';
import type { MergeResult } from '../entity-service.js';
import type { Result } from '../../shared/result.js';

export interface MergeExecution {
  readonly dataRoot: string;
  readonly slug: string;
  readonly keep: string;
  readonly drop: string;
  readonly runId: string;
}

export interface ExtractExecution {
  readonly db: import('../../infrastructure/db/database.js').DatabaseSync;
  readonly itemId: string;
  readonly runId: string;
  readonly text: string;
  readonly extraction: import('../../domain/provider/relations.js').Extraction;
  readonly completed?: (result: AppliedExtraction) => void;
}

export interface ConsolidateOpDefinition {
  readonly kind: ConsolidateOpKind;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly validate: (payload: unknown) => boolean;
  readonly execute:
    | ((input: ExtractExecution) => AppliedExtraction)
    | ((input: MergeExecution) => Promise<Result<MergeResult>>)
    | ((input: import('./retype.js').RetypeExecution) => boolean)
    | null;
  readonly undoInfo: ((runId: string) => unknown) | null;
}
