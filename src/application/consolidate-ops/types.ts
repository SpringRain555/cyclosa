import type { ConsolidateOpKind } from '../../domain/research/consolidate.js';
import type { AppliedExtraction } from '../extraction-service.js';

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
    | ((input: DigestExecution) => AppliedDigest)
    | null;
  readonly undoInfo: ((runId: string) => unknown) | null;
}

export interface DigestExecution {
  readonly db: import('../../infrastructure/db/database.js').DatabaseSync;
  readonly itemId: string;
  readonly expectedUpdatedAt: number;
  readonly digest: import('../../domain/provider/digest.js').Digest;
  readonly model: string;
}

export interface AppliedDigest {
  readonly written: boolean;
  readonly code: import('../../domain/errors/codes.js').ErrorCode | null;
}
