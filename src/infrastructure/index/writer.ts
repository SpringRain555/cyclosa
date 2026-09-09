/**
 * 索引寫入。切分規則在 `domain/search/`，這一層只碰資料庫。
 *
 * > **索引在 Stage 6 匯入時就寫入，不是等 Stage 12。**
 * > 否則 Stage 12 要回頭替 5 萬筆重建索引 —— 而那是一個可以完全避免的動作
 * > （`roadmap.md`「為什麼檢索排在第 12」）。
 */
import type { DatabaseSync } from 'node:sqlite';

import { bigrams, indexTargets, latinRuns } from '../../domain/search/tokenize.js';
import { rankTitles } from '../../domain/search/collate.js';
import { allTitles, setTitleRank } from '../db/repositories/item-repo.js';

export type OwnerKind = 'item' | 'entity' | 'note';

/**
 * 重寫某個節點的索引。
 *
 * **先刪再寫**，因為重新抽取會產生不同的正文 ——
 * 只新增的話舊的 gram 會留下來，而使用者會查到一段已經不存在的文字。
 */
export function indexText(
  db: DatabaseSync,
  input: {
    readonly ownerKind: OwnerKind;
    readonly ownerId: string;
    readonly lang: string;
    readonly title: string;
    readonly text: string;
  },
): { readonly bigramRows: number; readonly ftsRows: number } {
  const targets = indexTargets(input.lang);
  // **標題也要進索引，而且要放在最前面** —— 使用者查的常常是標題裡的詞。
  const content = `${input.title}\n${input.text}`;

  db.prepare('DELETE FROM bigram WHERE owner_kind = ? AND owner_id = ?').run(
    input.ownerKind,
    input.ownerId,
  );
  db.prepare('DELETE FROM fts_text WHERE owner_id = ? AND owner_kind = ?').run(
    input.ownerId,
    input.ownerKind,
  );

  let bigramRows = 0;
  if (targets.bigram) {
    const insert = db.prepare(
      'INSERT INTO bigram (gram, owner_kind, owner_id, freq) VALUES (?, ?, ?, ?)',
    );
    for (const [gram, freq] of bigrams(content)) {
      insert.run(gram, input.ownerKind, input.ownerId, freq);
      bigramRows++;
    }
  }

  // **中文內容進 FTS 的只有裡面的拉丁字。**
  // 整段進去的話，`unicode61` 會把中文切成一個永遠查不到的巨大 token，
  // 而那個 token 要付 229% 的索引空間（量測見 `indexTargets`）。
  let ftsRows = 0;
  if (targets.fts !== 'none') {
    const body = targets.fts === 'latin' ? latinRuns(content).join(' ') : content;
    if (body.trim().length > 0) {
      db.prepare('INSERT INTO fts_text (owner_id, owner_kind, content) VALUES (?, ?, ?)').run(
        input.ownerId,
        input.ownerKind,
        body,
      );
      ftsRows = 1;
    }
  }

  return { bigramRows, ftsRows };
}

export function dropIndexFor(db: DatabaseSync, ownerKind: OwnerKind, ownerId: string): void {
  db.prepare('DELETE FROM bigram WHERE owner_kind = ? AND owner_id = ?').run(ownerKind, ownerId);
  db.prepare('DELETE FROM fts_text WHERE owner_id = ? AND owner_kind = ?').run(ownerId, ownerKind);
}

/**
 * 整批重排標題名次。
 *
 * **一次 run 收尾時跑一次，不是每插入一筆就跑一次** ——
 * 名次是相對的，插入一筆會影響它後面的每一筆，
 * 而每筆都重排等於把匯入變成 O(n²)。代價寫在 `domain/search/collate.ts`。
 */
export function reindexTitleRank(db: DatabaseSync): number {
  const ranked = rankTitles(allTitles(db));
  for (const r of ranked) setTitleRank(db, r.id, r.rank);
  return ranked.length;
}
