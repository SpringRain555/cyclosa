import {
  nearbyEntityNames,
  cosineOf,
  type MergeThresholds,
} from '../domain/entity/merge-candidates.js';
import type { EntityLike } from '../domain/entity/identity.js';
import type { EmbedProvider } from '../infrastructure/providers/embed-ollama.js';
import { correlationId } from '../shared/id.js';
import { ok, err, type Result } from '../shared/result.js';

export interface SemanticMergeCandidate {
  readonly keep: string;
  readonly drop: string;
  readonly nameDistance: number;
  readonly similarity: number;
}

/** 每次以同一個嵌入服務重新計算名稱向量，不混用資料庫內別的模型或舊名稱向量。 */
export async function semanticMergeCandidates(
  rows: readonly EntityLike[],
  mentions: ReadonlyMap<string, number>,
  thresholds: MergeThresholds,
  embed: EmbedProvider | null,
  signal?: AbortSignal,
): Promise<Result<readonly SemanticMergeCandidate[]>> {
  const cid = correlationId();
  const pairs = nearbyEntityNames(rows, thresholds.maxNameDistance);
  if (pairs.length === 0) return ok([], cid);
  if (embed === null) return err('PROVIDER_NOT_CONFIGURED', cid, { task: 'embed' });
  const ids = new Set(pairs.flatMap((pair) => [pair.left, pair.right]));
  const selected = rows.filter((row) => ids.has(row.id));
  const vectors = new Map<string, Float32Array>();
  let dimension: number | null = null;
  for (let offset = 0; offset < selected.length; offset += 32) {
    const batch = selected.slice(offset, offset + 32);
    const result = await embed.embedDocuments(
      batch.map((row) => [row.name, ...(row.aliases ?? [])].join('\n')),
      signal,
    );
    if (result.kind === 'error') return err(result.code, cid, { task: 'embed' });
    if (dimension === null) dimension = result.value.dim;
    if (
      dimension <= 0 ||
      result.value.dim !== dimension ||
      result.value.vectors.length !== batch.length
    )
      return err('PROVIDER_EMBED_MODEL_MISMATCH', cid, { task: 'embed' });
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i],
        vector = result.value.vectors[i];
      if (
        row === undefined ||
        vector === undefined ||
        vector.length !== dimension ||
        cosineOf(vector, vector) === null
      )
        return err('PROVIDER_EMBED_MODEL_MISMATCH', cid, { task: 'embed' });
      vectors.set(row.id, vector);
    }
  }
  const candidates: SemanticMergeCandidate[] = [];
  for (const pair of pairs) {
    const a = vectors.get(pair.left),
      b = vectors.get(pair.right);
    if (a === undefined || b === undefined) continue;
    const similarity = cosineOf(a, b);
    if (similarity === null || similarity < thresholds.minSimilarity) continue;
    const countA = mentions.get(pair.left) ?? 0,
      countB = mentions.get(pair.right) ?? 0;
    const leftWins = countA > countB || (countA === countB && pair.left < pair.right);
    candidates.push({
      keep: leftWins ? pair.left : pair.right,
      drop: leftWins ? pair.right : pair.left,
      nameDistance: pair.nameDistance,
      similarity,
    });
  }
  return ok(
    candidates.sort(
      (a, b) =>
        b.similarity - a.similarity ||
        a.nameDistance - b.nameDistance ||
        a.keep.localeCompare(b.keep) ||
        a.drop.localeCompare(b.drop),
    ),
    cid,
  );
}
