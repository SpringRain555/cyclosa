/**
 * `tools/dev/apply-extraction.ts`：一份人給的抽取結果，走跟擴展一模一樣的路寫進專題。
 *
 * **要證明的只有一件事：它沒有繞過任何規則。**
 * 邊是 `pending`、`origin='machine'`、有出處、引文對得回 `derived/`；
 * 引文在原文裡找不到的那一條**不存在**；型別不在六個裡的實體被丟掉；
 * 作業紀錄有一列、記得是誰抽的。
 *
 * 用真的匯入管線放一份純文字進去（不需要網路），再對它套一份手寫的抽取。
 */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createCase } from '../../src/application/case-service.js';
import { importFile } from '../../src/application/ingest-service.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { applyManualExtraction } from '../../tools/dev/apply-extraction.js';
import { derivedPath } from '../../src/infrastructure/fs/case-files.js';

const QUOTE = '合成公司在二月宣布收購合成工作室，交易金額沒有揭露。';
const ARTICLE = [
  '合成報導：一樁沒有揭露金額的收購',
  '',
  '這是一份合成的測試資料，不是任何真實來源。下面這一段刻意寫得夠長，因為抽取信心的門檻之一是正文長度。',
  `${QUOTE}兩家公司都沒有回應進一步的詢問，而這一段的存在是為了讓上面那一句話有前後文。`,
  '第三段繼續講同一件事。關聯、出處、引文、獨立來源、墓碑、校準比例，這些詞出現在這裡是為了讓中文的 bigram 索引有東西可以切。',
  '第四段。快照存的是原始位元組而且不可變，衍生物可以整批刪掉重算。這幾句話同時也讓這篇文章的長度超過門檻。',
].join('\n');

let sandbox: string;
let dataRoot: string;
let slug: string;
let itemId: string;
let savedLocalAppData: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(join(tmpdir(), 'cyclosa-apply-'));
  dataRoot = join(sandbox, 'DataRoot');
  await mkdir(join(sandbox, 'LocalAppData'), { recursive: true });
  savedLocalAppData = process.env['LOCALAPPDATA'];
  process.env['LOCALAPPDATA'] = join(sandbox, 'LocalAppData');

  const created = await createCase(dataRoot, { name: '手動抽取驗收' });
  if (!created.ok) throw new Error(`建不了專題：${created.code}`);
  slug = created.data.slug;
  const imported = await importFile(dataRoot, slug, '報導.txt', new TextEncoder().encode(ARTICLE));
  if (!imported.ok || imported.data.itemId === null) throw new Error('匯入沒有產生節點');
  itemId = imported.data.itemId;
});

afterEach(async () => {
  if (savedLocalAppData === undefined) delete process.env['LOCALAPPDATA'];
  else process.env['LOCALAPPDATA'] = savedLocalAppData;
  await rm(sandbox, { recursive: true, force: true });
});

async function inDb<T>(fn: (db: import('node:sqlite').DatabaseSync) => T): Promise<T> {
  const opened = await openCaseDatabase(join(dataRoot, 'cases', slug, 'case.sqlite'));
  if (opened.kind !== 'ok') throw new Error('開不了專題資料庫');
  try {
    return fn(opened.db);
  } finally {
    opened.db.close();
  }
}

describe('人給的抽取結果走跟模型一樣的路', () => {
  it('邊是待查證、帶出處、引文對得回正文；找不到引文的那一條不存在；壞型別的實體被丟掉', async () => {
    const report = await applyManualExtraction(
      dataRoot,
      slug,
      [
        {
          itemId,
          raw: {
            entities: [
              { name: '合成公司', type: 'org' },
              { name: '合成工作室', type: 'org' },
              // 型別不在六個裡 —— `normalizeExtraction` 會丟掉它，跟模型吐的一樣
              { name: '不該出現的', type: 'spaceship' },
            ],
            relations: [
              { subject: '合成公司', rel: '收購', object: '合成工作室', quote: QUOTE },
              // 這一句原文裡沒有 —— 人編的也一樣沒有那條邊
              {
                subject: '合成工作室',
                rel: '控告',
                object: '合成公司',
                quote: '合成工作室在三月對合成公司提出告訴，求償一億元。',
              },
            ],
          },
        },
      ],
      'test',
    );
    expect('refused' in report).toBe(false);
    if ('refused' in report) return;

    // 兩條裡一條引文找不到 → 部分失敗，而且說得出來
    expect(report.status).toBe('partial');
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.entities).toBe(2);
    expect(report.rows[0]?.relations).toBe(2);
    expect(report.rows[0]?.code).toBe('PROVIDER_QUOTE_NOT_FOUND');

    const rows = await inDb((db) => ({
      entities: db.prepare('SELECT name_zh FROM entity ORDER BY name_zh').all() as {
        name_zh: string;
      }[],
      named: db.prepare("SELECT * FROM edge WHERE layer='named'").all() as Record<
        string,
        unknown
      >[],
      comention: (
        db.prepare("SELECT COUNT(*) n FROM edge WHERE layer='comention'").get() as { n: number }
      ).n,
      evidence: db.prepare('SELECT * FROM edge_evidence').all() as Record<string, unknown>[],
      run: db.prepare('SELECT * FROM run WHERE id = ?').get(report.runId) as Record<
        string,
        unknown
      >,
      runItems: db.prepare('SELECT * FROM run_item WHERE run_id = ?').all(report.runId) as Record<
        string,
        unknown
      >[],
    }));

    expect(rows.entities.map((e) => e.name_zh)).toEqual(['合成公司', '合成工作室']);
    expect(rows.comention).toBe(2);
    expect(rows.named).toHaveLength(1);
    expect(rows.named[0]?.['rel']).toBe('收購');
    // **沒有任何一條路通往自動確認** —— 人在對話裡抽的也進待查證
    expect(rows.named[0]?.['status']).toBe('pending');
    expect(rows.named[0]?.['origin']).toBe('machine');
    expect(rows.named[0]?.['run_id']).toBe(report.runId);

    expect(rows.evidence).toHaveLength(1);
    const ev = rows.evidence[0] as { item_id: string; char_start: number; char_end: number };
    const derived = JSON.parse(
      await readFile(derivedPath(join(dataRoot, 'cases', slug), ev.item_id), 'utf8'),
    ) as { text: string };
    expect(derived.text.slice(ev.char_start, ev.char_end)).toBe(QUOTE);

    // 作業紀錄：一列 run、記得是誰抽的；一列 run_item 指回那份資料
    expect(rows.run['kind']).toBe('extract');
    expect(rows.run['status']).toBe('partial');
    expect(String(rows.run['providers_json'])).toContain('manual:test');
    expect(rows.runItems).toHaveLength(1);
    expect(rows.runItems[0]?.['item_id']).toBe(itemId);
    // 新邊 ＝ 兩條共同提及 ＋ 一條具名 —— 跟擴展作業記的是同一個數字
    expect(rows.runItems[0]?.['new_edges']).toBe(3);
    expect(report.rows[0]?.newEdges).toBe(3);
  });

  it('不存在的 itemId 那一列標失敗，其餘照寫 —— 部分失敗是一等公民', async () => {
    const report = await applyManualExtraction(
      dataRoot,
      slug,
      [
        { itemId: 'no-such-item', raw: { entities: [{ name: 'X', type: 'org' }], relations: [] } },
        { itemId, raw: { entities: [{ name: '合成公司', type: 'org' }], relations: [] } },
      ],
      'test',
    );
    if ('refused' in report) throw new Error(report.refused);
    expect(report.status).toBe('partial');
    expect(report.rows.map((r) => r.outcome)).toEqual(['failed', 'ok']);
    expect(report.rows[0]?.code).toBe('GRAPH_NODE_NOT_FOUND');
    const n = await inDb(
      (db) => (db.prepare('SELECT COUNT(*) n FROM entity').get() as { n: number }).n,
    );
    expect(n).toBe(1);
  });

  it('已封存的專題拒絕寫', async () => {
    await inDb((db) => db.prepare('UPDATE "case" SET status=\'archived\'').run());
    const report = await applyManualExtraction(dataRoot, slug, [], 'test');
    expect('refused' in report).toBe(true);
  });
});
