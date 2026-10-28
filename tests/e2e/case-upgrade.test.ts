/**
 * 舊資料升級成新格式（ADR-0039 第五節）。
 *
 * 用 v1.1.0 的匯入建好資料，再把它「退回」v2 的樣子（正文是原文、沒有 `blocks`、版號 2、專題沒升級過），
 * 然後看升級有沒有把每一樣都換成新格式：Markdown 重抽、帶記號的引文與點註換到新正文、`.txt` 一字不差所以什麼都不動、
 * 網頁只換版號、附件換標題與索引、舊版檔刪掉、對不上的數出來。
 */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCase } from '../../src/application/case-service.js';
import {
  forgetUpgradeChecks,
  upgradeCase,
  UPGRADE_NOTICE_KIND,
} from '../../src/application/case-upgrade.js';
import { importFile } from '../../src/application/ingest-service.js';
import { attachNoteFile } from '../../src/application/note-service.js';
import { textSelectors } from '../../src/domain/annotation/index.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { insertEdge, insertEvidence } from '../../src/infrastructure/db/repositories/edge-repo.js';
import { insertNote } from '../../src/infrastructure/db/repositories/note-repo.js';
import {
  EXTRACTOR_VERSION,
  derivedPath,
  readDerived,
  readDerivedAt,
} from '../../src/infrastructure/fs/case-files.js';
import { buildServer } from '../../src/server.js';

const NOTE_MD = [
  '---',
  'title: 會議紀錄',
  'tags: [研究]',
  '---',
  '# 決議',
  '',
  '這是**重點**的結論，交給 [[專案甲|甲案]]。',
].join('\n');
const PLAIN = '純文字第一行\n第二行照舊';
const PAGE = `<html><head><title>網頁</title></head><body><article><h1>網頁</h1>${'<p>這是一份網頁的正文，用來確認沒改過的種類只換版號、內容一字不動。</p>'.repeat(6)}</article></body></html>`;
const ATTACHMENT = '---\ntitle: 附件標題\n---\n# 附件\n**內容**';

let root = '';
let slug = '';
let folder = '';
let mdId = '';
let txtId = '';
let webId = '';
let attachmentId = '';
let evidenceId = '';
let markedNoteId = '';
let markupOnlyNoteId = '';

async function withDb<T>(body: (db: DatabaseSync) => T | Promise<T>): Promise<T> {
  const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error(opened.kind);
  try {
    return await body(opened.db);
  } finally {
    opened.db.close();
  }
}

async function imported(name: string, body: string): Promise<string> {
  const result = await importFile(root, slug, name, Buffer.from(body));
  if (!result.ok || result.data.itemId === null) throw new Error(`匯入 ${name} 失敗`);
  return result.data.itemId;
}

/** 把一份資料退回 v2：正文換成 `text`（v2 的 Markdown 就是原文）、拿掉 `blocks`、版號 2。 */
async function downgrade(
  db: DatabaseSync,
  id: string,
  text: string | null,
  title?: string,
): Promise<void> {
  const current = await readDerived(folder, id);
  if (current === null) throw new Error('沒有正文');
  const { blocks: _blocks, ...rest } = current;
  const old = {
    ...rest,
    extractorVersion: 2,
    text: text ?? current.text,
    ...(title ? { title } : {}),
  };
  await writeFile(derivedPath(folder, id, 2), JSON.stringify(old), 'utf8');
  await rm(derivedPath(folder, id, EXTRACTOR_VERSION));
  db.prepare('UPDATE item SET extractor_version = 2, title = ? WHERE id = ?').run(old.title, id);
}

function addVector(db: DatabaseSync, ownerId: string): void {
  db.prepare(
    `INSERT INTO vector (id, owner_kind, owner_id, model, dim, embedding, created_at)
     VALUES (?, 'item', ?, 'test-embed', 2, ?, 1)`,
  ).run(`vec-${ownerId}`, ownerId, Buffer.from(new Float32Array([0.1, 0.2]).buffer));
}

beforeEach(async () => {
  forgetUpgradeChecks();
  root = await mkdtemp(join(tmpdir(), 'cyclosa-upgrade-'));
  const created = await createCase(root, { name: '升級測試' });
  if (!created.ok) throw new Error(created.code);
  slug = created.data.slug;
  folder = join(root, 'cases', slug);

  mdId = await imported('會議.md', NOTE_MD);
  txtId = await imported('plain.txt', PLAIN);
  webId = await imported('page.html', PAGE);
  const attached = await attachNoteFile(root, slug, txtId, { fileName: 'x.md', body: ATTACHMENT });
  if (!attached.ok) throw new Error(attached.code);
  attachmentId = attached.data.note.note.id;

  const oldText = NOTE_MD.trim();
  await withDb(async (db) => {
    await downgrade(db, mdId, oldText, '---');
    await downgrade(db, txtId, null);
    await downgrade(db, webId, null);
    // 附件照 v1.0.1 之前的規則：標題取第一個 `# `，摘要是原文。
    db.prepare('UPDATE item SET title = ?, excerpt = ? WHERE id = ?').run(
      '附件',
      ATTACHMENT,
      attachmentId,
    );
    db.prepare('UPDATE "case" SET derived_version = 0').run();

    // 一條帶記號的機器引文（v2 的正文就是原文）。
    const quote = '這是**重點**的結論';
    const edge = insertEdge(
      db,
      {
        layer: 'named',
        rel: '交給',
        source: mdId,
        sourceKind: 'item',
        target: txtId,
        targetKind: 'item',
        origin: 'machine',
        confidence: 0.5,
      },
      1000,
    );
    insertEvidence(
      db,
      edge,
      [
        {
          itemId: mdId,
          quote,
          charStart: oldText.indexOf(quote),
          charEnd: oldText.indexOf(quote) + quote.length,
        },
      ],
      1000,
    );
    evidenceId = String(
      (db.prepare('SELECT id FROM edge_evidence WHERE edge_id = ?').get(edge) as { id: string }).id,
    );

    // 兩則點註：一則框到「**重點**」，一則只框到記號（換不過去，要數出來）。
    const sha = String(
      (db.prepare('SELECT sha256 FROM item WHERE id = ?').get(mdId) as { sha256: string }).sha256,
    );
    const note = (id: string, start: number, end: number): void => {
      const built = textSelectors(oldText, start, end);
      if (built.kind !== 'ok') throw new Error(built.kind);
      insertNote(db, {
        id,
        itemId: mdId,
        title: id,
        body: '點註',
        selectorJson: JSON.stringify(built.selectors),
        snapshotSha256: sha,
        anchorOk: true,
        now: 1000,
      });
    };
    markedNoteId = 'note-marked';
    markupOnlyNoteId = 'note-markup';
    const at = oldText.indexOf('**重點**');
    note(markedNoteId, at, at + '**重點**'.length);
    const fence = oldText.indexOf('---', 3);
    note(markupOnlyNoteId, fence, fence + 3);

    addVector(db, mdId);
    addVector(db, txtId);
  });
});

afterEach(async () => {
  forgetUpgradeChecks();
  await rm(root, { recursive: true, force: true });
});

describe('升級舊資料（ADR-0039 第五節）', () => {
  it('Markdown 重抽、引文與點註換到新正文、.txt 不動、網頁只換版號、附件換標題、舊版檔刪掉', async () => {
    const report = await upgradeCase(root, slug);
    if (typeof report === 'string') throw new Error(report);

    expect(report).toMatchObject({
      from: 0,
      to: EXTRACTOR_VERSION,
      reextracted: 2,
      changed: 1,
      restamped: 1,
      failed: 0,
      vectorsDropped: 1,
      attachments: 1,
      evidence: { checked: 1, rewritten: 1, unresolved: 0 },
      notes: { checked: 2, rewritten: 1, unresolved: 1 },
    });

    // Markdown：看得到的字＋結構，標題照 frontmatter。
    const md = await readDerived(folder, mdId);
    expect(md?.text).toBe('title: 會議紀錄\ntags: [研究]\n\n決議\n\n這是重點的結論，交給 甲案。');
    expect(md?.blocks?.map((b) => b.kind)).toEqual(['frontmatter', 'heading', 'paragraph']);
    // `.txt` 與網頁：一字不差。
    expect((await readDerived(folder, txtId))?.text).toBe(PLAIN);
    expect((await readDerived(folder, webId))?.blocks).toBeNull();
    // 舊版檔都刪掉了。
    for (const id of [mdId, txtId, webId]) {
      await expect(access(derivedPath(folder, id, 2))).rejects.toThrow();
      expect(await readDerivedAt(folder, id, EXTRACTOR_VERSION)).not.toBeNull();
    }

    await withDb(async (db) => {
      const versions = db
        .prepare('SELECT id, extractor_version v, title FROM item WHERE id IN (?, ?, ?)')
        .all(mdId, txtId, webId) as { id: string; v: number; title: string }[];
      expect(versions.every((r) => r.v === EXTRACTOR_VERSION)).toBe(true);
      expect(versions.find((r) => r.id === mdId)?.title).toBe('會議紀錄');

      // 帶記號的引文換成新正文的字，位置指得到它。
      const evidence = db
        .prepare('SELECT quote, char_start s, char_end e FROM edge_evidence WHERE id = ?')
        .get(evidenceId) as { quote: string; s: number; e: number };
      expect(evidence.quote).toBe('這是重點的結論');
      expect(md?.text.slice(evidence.s, evidence.e)).toBe('這是重點的結論');

      // 點註：框到「**重點**」的那一則換成「重點」；只框到記號的那一則對不上、留著。
      const notes = db
        .prepare('SELECT id, selector_json j, anchor_ok ok, md_path p FROM note WHERE id IN (?, ?)')
        .all(markedNoteId, markupOnlyNoteId) as {
        id: string;
        j: string;
        ok: number;
        p: string | null;
      }[];
      const marked = notes.find((n) => n.id === markedNoteId);
      expect(JSON.parse(String(marked?.j))[0]).toMatchObject({
        type: 'TextQuoteSelector',
        exact: '重點',
      });
      expect(marked?.ok).toBe(1);
      expect(await readFile(String(marked?.p), 'utf8')).toContain('> 重點');
      expect(notes.find((n) => n.id === markupOnlyNoteId)?.ok).toBe(0);

      // 向量：Markdown 那份作廢（正文變了），.txt 那份留著（一字不差）。
      const vectors = db.prepare('SELECT owner_id FROM vector ORDER BY owner_id').all() as {
        owner_id: string;
      }[];
      expect(vectors.map((v) => v.owner_id)).toEqual([txtId]);

      // 附件：Markdown 的標題規則、摘要是看得到的字。
      const attachment = db
        .prepare('SELECT title, excerpt FROM item WHERE id = ?')
        .get(attachmentId) as { title: string; excerpt: string };
      expect(attachment).toEqual({ title: '附件標題', excerpt: 'title: 附件標題\n\n附件\n\n內容' });

      // 一則升級通知；專題記成現行版。
      const notices = db.prepare('SELECT kind, body_json FROM case_notice').all() as {
        kind: string;
        body_json: string;
      }[];
      expect(notices.map((n) => n.kind)).toEqual([UPGRADE_NOTICE_KIND]);
      expect(db.prepare('SELECT derived_version v FROM "case"').get()).toEqual({
        v: EXTRACTOR_VERSION,
      });
    });

    // 第二次什麼都不做。
    expect(await upgradeCase(root, slug)).toBe('current');
  });

  it('**帶 `:slug` 的請求先升級才進路由** —— 閱讀器拿到的就是新格式', async () => {
    const built = await buildServer();
    built.ctx.dataRoot = root;
    await built.app.ready();
    try {
      const res = await built.app.inject({
        method: 'GET',
        url: `/api/cases/${slug}/items/${mdId}/content`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        data: { derived: { extractorVersion: number; blocks: unknown[] } };
      };
      expect(body.data.derived.extractorVersion).toBe(EXTRACTOR_VERSION);
      expect(body.data.derived.blocks.length).toBeGreaterThan(0);
      expect(body.data).not.toHaveProperty('stale');
    } finally {
      await built.app.close();
    }
  });

  it('只換版號的專題（沒有 Markdown、沒有附件）不寫通知', async () => {
    await withDb((db) => {
      db.prepare('DELETE FROM item WHERE id NOT IN (?)').run(webId);
    });
    const report = await upgradeCase(root, slug);
    if (typeof report === 'string') throw new Error(report);
    expect(report).toMatchObject({
      reextracted: 0,
      restamped: 1,
      changed: 0,
      vectorsDropped: 0,
      attachments: 0,
    });
    await withDb((db) => {
      expect(db.prepare('SELECT COUNT(*) n FROM case_notice').get()).toEqual({ n: 0 });
    });
  });
});
