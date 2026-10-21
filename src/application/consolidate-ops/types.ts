import type { ConsolidateOpKind } from '../../domain/research/consolidate.js';
import type { AppliedExtraction } from '../extraction-service.js';

export interface ExtractExecution {
  readonly db: import('../../infrastructure/db/database.js').DatabaseSync;
  readonly itemId: string;
  readonly runId: string;
  readonly text: string;
  readonly extraction: import('../../domain/provider/relations.js').Extraction;
  readonly completed?: (result: AppliedExtraction) => void;
  readonly addEdge?: import('../../domain/research/consolidate.js').ConsolidateOpPayloadByKind['add-edge'];
}

export interface ConsolidateOpDefinition {
  readonly kind: ConsolidateOpKind;
  readonly schema: Readonly<Record<string, unknown>>;
  readonly validate: (payload: unknown) => boolean;
  readonly execute: ((input: ExtractExecution) => AppliedExtraction) | null;
  readonly undoInfo: ((runId: string) => unknown) | null;
}
