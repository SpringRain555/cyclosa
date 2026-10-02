import type { ErrorCode } from '../domain/errors/codes.js';
import { scoreFor } from '../domain/graph/index.js';
import { locateQuote, type Extraction } from '../domain/provider/index.js';
import { withTransaction, type DatabaseSync } from '../infrastructure/db/database.js';
import * as entities from '../infrastructure/db/repositories/entity-repo.js';
import { applyProposal } from '../infrastructure/db/repositories/edge-repo.js';
import { newId } from '../shared/id.js';

const MENTION_REL = '提到';
const MENTION_CONFIDENCE = 0.9;

export interface AppliedExtraction {
  readonly newEdges: number;
  readonly code: ErrorCode | null;
}

export function applyExtraction(
  db: DatabaseSync,
  itemId: string,
  runId: string,
  text: string,
  extraction: Extraction,
  completed?: (result: AppliedExtraction) => void,
): AppliedExtraction {
  let quoteMisses = 0;
  const newEdges = withTransaction(db, () => {
    const now = Date.now();
    let known = entities.listEntities(db);
    const idOf = new Map<string, string>();
    for (const draft of extraction.entities) {
      const found = entities.findEntityFor(known, draft.name, draft.type);
      if (found !== null) {
        idOf.set(draft.name, found.id);
        entities.addAlias(db, found.id, draft.name, now);
        continue;
      }
      const id = newId();
      entities.insertEntity(db, { id, type: draft.type, name: draft.name, now });
      known = [...known, { id, name: draft.name, type: draft.type, aliases: [], mergedInto: null }];
      idOf.set(draft.name, id);
    }

    let written = 0;
    for (const draft of extraction.entities) {
      const entityId = idOf.get(draft.name);
      if (entityId === undefined) continue;
      const result = applyProposal(
        db,
        {
          source: itemId,
          target: entityId,
          rel: MENTION_REL,
          layer: 'comention',
          sourceKind: 'item',
          targetKind: 'entity',
          confidence: MENTION_CONFIDENCE,
          evidence: [],
          runId,
        },
        now,
      );
      if (result.kind === 'created') written++;
    }

    for (const relation of extraction.relations) {
      const source = idOf.get(relation.subject);
      const target = idOf.get(relation.object);
      if (source === undefined || target === undefined) continue;
      const at = locateQuote(text, relation.quote);
      if (at.kind !== 'found') {
        quoteMisses++;
        continue;
      }
      const result = applyProposal(
        db,
        {
          source,
          target,
          rel: relation.rel,
          layer: 'named',
          sourceKind: 'entity',
          targetKind: 'entity',
          confidence: scoreFor({ independentSourceCount: 1, hasDirectQuote: true }),
          evidence: [
            { itemId, quote: text.slice(at.start, at.end), charStart: at.start, charEnd: at.end },
          ],
          runId,
        },
        now,
      );
      if (result.kind === 'created' || result.kind === 'revived') written++;
    }
    completed?.({ newEdges: written, code: quoteMisses > 0 ? 'PROVIDER_QUOTE_NOT_FOUND' : null });
    return written;
  });
  return { newEdges, code: quoteMisses > 0 ? 'PROVIDER_QUOTE_NOT_FOUND' : null };
}
