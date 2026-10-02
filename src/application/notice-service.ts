import { join } from 'node:path';
import { openCaseDatabase } from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import { dismissNotice, listOpenNotices } from '../infrastructure/db/repositories/notice-repo.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { err, ok } from '../shared/result.js';

async function open(dataRoot: string, slug: string, cid: string) {
  const opened = await openCaseDatabase(join(casesDir(dataRoot), slug, 'case.sqlite'), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new')
    return err('CASE_SCHEMA_TOO_NEW', cid, { found: opened.found });
  if (opened.kind === 'migrate-failed')
    return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { at: opened.at });
  if (opened.kind === 'missing') return err('CASE_NOT_FOUND', cid, { slug });
  if (readCase(opened.db) === null) {
    opened.db.close();
    return err('CASE_NOT_FOUND', cid, { slug });
  }
  return ok(opened.db, cid);
}

export async function listCaseNotices(dataRoot: string, slug: string) {
  const cid = correlationId();
  const opened = await open(dataRoot, slug, cid);
  if (!opened.ok) return opened;
  try {
    return ok(listOpenNotices(opened.data), cid);
  } finally {
    opened.data.close();
  }
}

export async function dismissCaseNotice(dataRoot: string, slug: string, noticeId: string) {
  const cid = correlationId();
  const opened = await open(dataRoot, slug, cid);
  if (!opened.ok) return opened;
  try {
    return ok({ dismissed: dismissNotice(opened.data, noticeId, Date.now()) }, cid);
  } finally {
    opened.data.close();
  }
}
