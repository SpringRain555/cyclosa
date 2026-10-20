import { EXTRACT_OP_SCHEMA } from '../../domain/research/consolidate.js';
import { conformsTo } from '../../domain/provider/schema-check.js';
import { applyExtraction, type AppliedExtraction } from '../extraction-service.js';
import type { ExtractExecution, ConsolidateOpDefinition } from './types.js';

export function executeExtractOperation(input: ExtractExecution): AppliedExtraction {
  return applyExtraction(
    input.db,
    input.itemId,
    input.runId,
    input.text,
    input.extraction,
    input.completed,
  );
}

export const extract: ConsolidateOpDefinition = {
  kind: 'extract',
  schema: EXTRACT_OP_SCHEMA,
  validate: (payload) => conformsTo(EXTRACT_OP_SCHEMA, payload).ok,
  execute: executeExtractOperation,
  undoInfo: (runId) => ({ runId }),
};
