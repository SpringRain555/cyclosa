/**
 * 把一份**不是模型產生的**抽取結果寫進專題 —— 走跟擴展一模一樣的路。
 *
 * ```
 * npx tsx tools/dev/apply-extraction.ts --data-root <資料根> --slug <專題> --file <json> [--by <誰>]
 * ```
 *
 * ## 為什麼需要它
 *
 * 2026-09-16 定的：下一輪由 agent（Claude Code）在對話裡頂替 `chat`，對一篇論文抽實體與關係。
 * 抽出來的東西要進資料庫，而那時唯一的入口是 `extractInto` 內部的模型呼叫。
 * 手動連線那條路（`origin='human'`、自動已確認、不用引文）**跳過了裁決** —— 不是同一件事。
 *
 * 所以 `expand-service.ts` 把「問模型」與「寫進去」拆成兩半，這一支只呼叫後者
 * （`applyExtraction`）：實體對齊、共同提及、`locateQuote`、`applyProposal`、待查證、
 * 墓碑 —— **規則一條都沒繞過**。引文在原文裡找不到就沒有那條邊，對人給的也一樣。
 *
 * ## 輸入的形狀
 *
 * 一個 JSON 陣列，每一項是一份資料節點的抽取結果，形狀就是 `EXTRACT_SCHEMA` 加一個 `itemId`：
 *
 * ```json
 * [{ "itemId": "…", "entities": [{ "name": "…", "type": "org" }],
 *    "relations": [{ "subject": "…", "rel": "…", "object": "…", "quote": "原文裡一字不差的一段" }] }]
 * ```
 *
 * 每一項先過 `normalizeExtraction`（跟模型的輸出同一支）—— 型別不在六個裡的實體會被丟掉，
 * 關係的兩端要是宣告過的實體，引文有長度上下界。
 *
 * ## 它留下什麼
 *
 * 一個 `kind='extract'` 的作業（`label`「手動抽取」、`providers_json` 記 `chat: manual:<誰>`），
 * 每一份一列 `run_item`。所以作業紀錄看得到、**復原得掉**、寫進去的邊帶著 `run_id`。
 *
 * ## 三道防線（跟 `seed-graph.ts` 同一種形狀）
 *
 * 1. 三個參數都必須明確給，沒有預設值
 * 2. 已封存的專題拒絕寫
 * 3. 不存在或沒有正文的 `itemId` 那一列標失敗，其餘照寫 —— 部分失敗是一等公民
 *
 * ⚠️ 這是開發工具。**產品程式碼不 import 它**，一鍵啟動也不會碰到它。
 * 資料根的規矩是「資料只由 App 自己寫」—— 這一支跑的是 App 自己的寫入路徑，
 * 而且只在使用者要求時執行。
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { applyExtraction } from '../../src/application/extraction-service.js';
import { normalizeExtraction } from '../../src/domain/provider/index.js';
import { openCaseDatabase } from '../../src/infrastructure/db/database.js';
import { readCase } from '../../src/infrastructure/db/repositories/case-repo.js';
import * as items from '../../src/infrastructure/db/repositories/item-repo.js';
import * as runs from '../../src/infrastructure/db/repositories/run-repo.js';
import { readDerived } from '../../src/infrastructure/fs/case-files.js';
import { correlationId, newId } from '../../src/shared/id.js';

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

interface ManualEntry {
  readonly itemId: string;
  readonly raw: unknown;
}

function parseEntries(raw: unknown): ManualEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: ManualEntry[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const itemId = (entry as { itemId?: unknown }).itemId;
    if (typeof itemId !== 'string' || itemId.trim().length === 0) return null;
    out.push({ itemId: itemId.trim(), raw: entry });
  }
  return out;
}

export interface ApplyReport {
  readonly runId: string;
  readonly status: 'done' | 'partial' | 'failed';
  readonly rows: readonly {
    readonly itemId: string;
    readonly outcome: 'ok' | 'failed';
    readonly entities: number;
    readonly relations: number;
    readonly newEdges: number;
    readonly code: string | null;
  }[];
}

/**
 * 真正做事的那一半，**不碰 `process`** —— 測試直接呼叫它。
 * `entries` 是解析過的輸入；每一項各自成敗。
 */
export async function applyManualExtraction(
  dataRoot: string,
  slug: string,
  entries: readonly ManualEntry[],
  by: string,
): Promise<ApplyReport | { readonly refused: string }> {
  const folder = join(dataRoot, 'cases', slug);
  const opened = await openCaseDatabase(join(folder, 'case.sqlite'));
  if (opened.kind !== 'ok') return { refused: `打不開專題資料庫（${opened.kind}）` };
  const db = opened.db;

  try {
    const caseRow = readCase(db);
    if (caseRow === null) return { refused: '這個資料夾裡沒有專題' };
    if (caseRow.status === 'archived') return { refused: '專題已封存，不寫' };

    const runId = newId();
    const now = Date.now();
    runs.insertRun(db, {
      id: runId,
      kind: 'extract',
      label: '手動抽取',
      total: entries.length,
      correlationId: correlationId(),
      now,
      topic: null,
      // **記下是誰抽的**。作業紀錄那一行存在的理由就是「兩次結果不同時查得出換了誰」。
      providers: JSON.stringify({ chat: `manual:${by}`, agent: null, json: { extract: 'manual' } }),
    });
    runs.startRun(db, runId, now);

    const rows: ApplyReport['rows'][number][] = [];
    for (const entry of entries) {
      const runItemId = newId();
      const item = items.getItem(db, entry.itemId);
      runs.insertRunItem(db, {
        id: runItemId,
        runId,
        requested: item?.sourceUrl ?? item?.title ?? entry.itemId,
        host: null,
      });

      const derived = item === null ? null : await readDerived(folder, entry.itemId);
      if (item === null || derived === null || derived.text.trim().length === 0) {
        const code = item === null ? 'GRAPH_NODE_NOT_FOUND' : 'PARSE_EMPTY_CONTENT';
        runs.updateRunItem(db, { id: runItemId, outcome: 'failed', code, now: Date.now() });
        rows.push({
          itemId: entry.itemId,
          outcome: 'failed',
          entities: 0,
          relations: 0,
          newEdges: 0,
          code,
        });
        continue;
      }

      // **跟模型的輸出走同一支正規化** —— 人給的也是外部輸入。
      const extraction = normalizeExtraction(entry.raw);
      const applied = applyExtraction(db, entry.itemId, runId, derived.text, extraction);
      runs.updateRunItem(db, {
        id: runItemId,
        outcome: 'ok',
        code: applied.code,
        itemId: entry.itemId,
        newNodes: 0,
        now: Date.now(),
      });
      runs.setRunItemEdges(db, runItemId, applied.newEdges);
      rows.push({
        itemId: entry.itemId,
        outcome: 'ok',
        entities: extraction.entities.length,
        relations: extraction.relations.length,
        newEdges: applied.newEdges,
        code: applied.code,
      });
    }

    const succeeded = rows.filter((r) => r.outcome === 'ok').length;
    const failed = rows.length - succeeded;
    // 有引文找不到的也算「部分失敗」—— 那是這個工具對「少了幾條邊」該有的誠實。
    const anyCode = rows.some((r) => r.code !== null);
    const status: ApplyReport['status'] =
      succeeded === 0 ? 'failed' : failed > 0 || anyCode ? 'partial' : 'done';
    runs.settleRunRow(db, { id: runId, status, succeeded, failed, now: Date.now() });

    return { runId, status, rows };
  } finally {
    db.close();
  }
}

async function main(): Promise<number> {
  const dataRoot = arg('data-root');
  const slug = arg('slug');
  const file = arg('file');
  const by = arg('by') ?? 'manual';

  if (dataRoot === null || slug === null || file === null) {
    console.error(
      '用法：npx tsx tools/dev/apply-extraction.ts --data-root <資料根> --slug <專題> --file <json> [--by <誰>]',
    );
    console.error('三個參數都必須明確給 —— 這支會寫入資料庫，不設預設值。');
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    console.error(`讀不了或解析不了 ${file}：${String((e as Error).message)}`);
    return 2;
  }
  const entries = parseEntries(parsed);
  if (entries === null) {
    console.error('輸入要是一個陣列，每一項至少要有字串的 itemId。');
    return 2;
  }

  const report = await applyManualExtraction(dataRoot, slug, entries, by);
  if ('refused' in report) {
    console.error(report.refused);
    return 1;
  }

  console.log(`作業 ${report.runId}：${report.status}`);
  for (const row of report.rows) {
    const note = row.code === null ? '' : ` （${row.code}）`;
    console.log(
      `  ${row.itemId}  ${row.outcome}  實體 ${String(row.entities)}／關係 ${String(row.relations)}／新邊 ${String(row.newEdges)}${note}`,
    );
  }
  return 0;
}

// 被 import 時不跑 —— 測試只要 `applyManualExtraction`。
if (process.argv[1] !== undefined && /apply-extraction\.ts$/.test(process.argv[1])) {
  process.exitCode = await main();
}
