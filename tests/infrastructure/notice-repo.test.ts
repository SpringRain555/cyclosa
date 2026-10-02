import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import {
  insertNotice,
  listOpenNotices,
  dismissNotice,
} from '../../src/infrastructure/db/repositories/notice-repo.js';

it('通知寫入、依時間與 id 列出；收起一次後不再列出，也不改寫原時間', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE item (id TEXT); CREATE TABLE research_candidate (id TEXT); CREATE TABLE research (id TEXT);',
    );
    db.exec(
      await readFile(
        new URL('../../src/infrastructure/db/migrations/012-research-build.sql', import.meta.url),
        'utf8',
      ),
    );
    expect(listOpenNotices(db)).toEqual([]);
    insertNotice(db, { id: 'b', kind: 'upgrade', bodyJson: '{"count":2}', createdAt: 2 });
    insertNotice(db, { id: 'a', kind: 'upgrade', bodyJson: '{}', createdAt: 1 });
    expect(listOpenNotices(db)).toEqual([
      { id: 'a', kind: 'upgrade', bodyJson: '{}', createdAt: 1, dismissedAt: null },
      { id: 'b', kind: 'upgrade', bodyJson: '{"count":2}', createdAt: 2, dismissedAt: null },
    ]);
    expect(dismissNotice(db, 'a', 3)).toBe(true);
    expect(dismissNotice(db, 'a', 4)).toBe(false);
    expect(dismissNotice(db, 'missing', 4)).toBe(false);
    expect(listOpenNotices(db).map((notice) => notice.id)).toEqual(['b']);
    expect(db.prepare("SELECT dismissed_at FROM case_notice WHERE id = 'a'").get()).toEqual({
      dismissed_at: 3,
    });
  } finally {
    db.close();
  }
});
