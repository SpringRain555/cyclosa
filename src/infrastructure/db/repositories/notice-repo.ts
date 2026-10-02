import type { DatabaseSync } from 'node:sqlite';

export interface NoticeRow {
  readonly id: string;
  readonly kind: string;
  readonly bodyJson: string;
  readonly createdAt: number;
  readonly dismissedAt: number | null;
}

export function insertNotice(db: DatabaseSync, input: Omit<NoticeRow, 'dismissedAt'>): void {
  db.prepare('INSERT INTO case_notice (id, kind, body_json, created_at) VALUES (?, ?, ?, ?)').run(
    input.id,
    input.kind,
    input.bodyJson,
    input.createdAt,
  );
}

export function listOpenNotices(db: DatabaseSync): readonly NoticeRow[] {
  return db
    .prepare('SELECT * FROM case_notice WHERE dismissed_at IS NULL ORDER BY created_at, id')
    .all()
    .map((row) => ({
      id: String(row['id']),
      kind: String(row['kind']),
      bodyJson: String(row['body_json']),
      createdAt: Number(row['created_at']),
      dismissedAt: null,
    }));
}

export function dismissNotice(db: DatabaseSync, id: string, now: number): boolean {
  return (
    db
      .prepare('UPDATE case_notice SET dismissed_at = ? WHERE id = ? AND dismissed_at IS NULL')
      .run(now, id).changes > 0
  );
}
