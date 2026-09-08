/**
 * 實體對齊：找出「可能是同一個」，讓人決定（Stage 10.5）。
 *
 * ## 為什麼一定要人按
 *
 * 跟關聯要人裁決是同一條規則，而且更強：
 * **一條錯的關聯是一條看得到的線，一次錯的合併會把兩個人的事蹟混成一個人 ——
 * 而混進去之後每一條線看起來都正常。**
 *
 * ## 為什麼可以取消
 *
 * `entity-repo.ts` 開頭那段從 Stage 9 就寫著「合錯了沒有工具可以拆開」。
 * 這一階段做的第一件事就是把那句話變成假的：合併不刪任何一列，
 * 而且**動了哪幾條邊記在 `entity_merge` 裡** —— 取消就是照著那份紀錄動回去。
 */
import { join } from 'node:path';

import { suggestMerges, type MatchReason } from '../domain/entity/identity.js';
import { openCaseDatabase, type DatabaseSync } from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import * as entities from '../infrastructure/db/repositories/entity-repo.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId, newId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';

const CASE_DB_FILE = 'case.sqlite';

async function withCase<T>(
  dataRoot: string,
  slug: string,
  body: (db: DatabaseSync) => Promise<Result<T>> | Result<T>,
): Promise<Result<T>> {
  const cid = correlationId();
  const opened = await openCaseDatabase(join(casesDir(dataRoot), slug, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new')
    return err('CASE_SCHEMA_TOO_NEW', cid, { found: opened.found });
  if (opened.kind === 'migrate-failed')
    return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { at: opened.at });
  try {
    if (readCase(opened.db) === null) return err('CASE_NOT_FOUND', cid, { slug });
    return await body(opened.db);
  } finally {
    opened.db.close();
  }
}

export interface EntitySide {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly aliases: readonly string[];
  /** 被幾份文件提到。**留哪一個是照這個數字決定的**，所以畫面上要看得到。 */
  readonly mentions: number;
}

export interface MergeCandidate {
  readonly keep: EntitySide;
  readonly merge: EntitySide;
  /** 為什麼覺得是同一個。**沒有理由的建議不該按。** */
  readonly reason: MatchReason;
}

function mentionCountsOf(db: DatabaseSync): ReadonlyMap<string, number> {
  const rows = db
    .prepare(
      `SELECT id, SUM(n) AS n FROM (
         SELECT target_id AS id, COUNT(DISTINCT source_id) AS n FROM edge
           WHERE target_kind = 'entity' AND source_kind = 'item' GROUP BY target_id
         UNION ALL
         SELECT source_id AS id, COUNT(DISTINCT target_id) AS n FROM edge
           WHERE source_kind = 'entity' AND target_kind = 'item' GROUP BY source_id
       ) GROUP BY id`,
    )
    .all() as Record<string, unknown>[];
  return new Map(rows.map((r) => [String(r['id']), Number(r['n'] ?? 0)]));
}

/** 這個專題裡看起來是同一個的那些配對。 */
export async function listMergeCandidates(
  dataRoot: string,
  slug: string,
): Promise<Result<readonly MergeCandidate[]>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    const rows = entities.listEntities(db);
    const counts = mentionCountsOf(db);
    const byId = new Map(rows.map((e) => [e.id, e]));

    const side = (id: string): EntitySide | null => {
      const row = byId.get(id);
      if (row === undefined) return null;
      return {
        id: row.id,
        name: row.name,
        type: row.type,
        aliases: row.aliases,
        mentions: counts.get(id) ?? 0,
      };
    };

    const out: MergeCandidate[] = [];
    for (const s of suggestMerges(rows, (id) => counts.get(id) ?? 0)) {
      const keep = side(s.keepId);
      const merge = side(s.mergeId);
      if (keep === null || merge === null) continue;
      out.push({ keep, merge, reason: s.reason });
    }
    return ok(out, cid);
  });
}

export interface MergeResult {
  readonly keptId: string;
  readonly mergedId: string;
  readonly movedEdges: number;
  /**
   * 併完之後多出來的平行線有幾條。
   *
   * **不是錯誤，但要說出來** —— 合併兩條邊要決定它們的出處、狀態與
   * 裁決歷史怎麼處理，而那些決定沒有一個可以自動做對。
   * 使用者看得到就可以自己否決其中一條。
   */
  readonly duplicateEdges: number;
}

export async function mergeEntity(
  dataRoot: string,
  slug: string,
  keptId: string,
  mergedId: string,
  reason = 'manual',
): Promise<Result<MergeResult>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    if (keptId === mergedId) return err('GRAPH_SELF_EDGE', cid, { keptId });

    const kept = entities.getEntity(db, keptId);
    const merged = entities.getEntity(db, mergedId);
    if (kept === null || merged === null) return err('GRAPH_NODE_NOT_FOUND', cid, { keptId });
    // 已經被併掉的不能再併一次 —— 那會做出一條鏈，而鏈上的中間那一個
    // 取消合併之後會指向一個已經不在原位的東西。
    if (merged.mergedInto !== null) return err('GRAPH_TRANSITION_INVALID', cid, { why: 'merged' });
    if (kept.mergedInto !== null) return err('GRAPH_TRANSITION_INVALID', cid, { why: 'kept' });
    if (kept.type !== merged.type) return err('GRAPH_TRANSITION_INVALID', cid, { why: 'type' });

    const result = entities.mergeEntities(db, {
      id: newId(),
      keptId,
      mergedId,
      reason,
      now: Date.now(),
    });
    return ok(
      {
        keptId,
        mergedId,
        movedEdges: result.moved.length,
        duplicateEdges: result.duplicates,
      },
      cid,
    );
  });
}

export async function unmergeEntity(
  dataRoot: string,
  slug: string,
  mergedId: string,
): Promise<Result<{ readonly restored: number }>> {
  return withCase(dataRoot, slug, (db) => {
    const cid = correlationId();
    const done = entities.unmergeEntity(db, mergedId, Date.now());
    if (done === null) return err('GRAPH_TRANSITION_INVALID', cid, { why: 'no-merge-record' });
    return ok(done, cid);
  });
}
