/**
 * 檢索（Stage 12）。**全文那一半 —— 語意還沒接上。**
 *
 * ## 這一支在做的事只有一句話：索引找候選，正文確認
 *
 * 索引從 Stage 6 匯入時就一直在寫，所以這裡沒有任何「建索引」的動作。
 * 而索引能回答的問題比使用者問的小一號：
 *
 * > **索引答得出**：這幾個 gram 都出現在這份文件裡。
 * > **使用者問的是**：這串字出現在這份文件裡。
 *
 * 兩者不一樣，而差額就是 ADR-0009 寫下來的那個代價 ——
 * 查「台積」會命中「…來台積極…」，因為那四個字裡真的有「台積」相鄰。
 * `bigram` 表裡沒有位置，所以這件事**在索引層看不出來**。
 *
 * 所以候選拿到之後回去讀正文，用 `findFirstFolded` 找那串字：
 * 找到的排前面並且切一段摘要，找不到的**留下來但標示**。
 * 這跟 Stage 11 匯出時重新驗引文是同一個判斷 —— 第四次了。
 *
 * ## 為什麼不是「查得到就對」
 *
 * 因為丟掉沒驗過的那些會讓搜尋在兩種情況下說謊：
 * 正文檔案不在（`derived/` 是可拋的，`rebuild` 會把它變回來），
 * 以及空白差異讓字串比對失敗、而它其實是對的。
 * 三種狀態各自有名字，合成一個布林值就會把「不知道」說成「不對」。
 *
 * ## 成本上界是寫死的，不是隨資料長大的
 *
 * 索引最多回 `CANDIDATE_CAP` 個候選，其中最多驗 `VERIFY_CAP` 個 ——
 * 驗一個要讀一個檔案，而 5 萬筆的專題裡一個常見的詞會有幾千個候選。
 * **不設上界的話，搜尋的成本會跟著專題長大**，而那正是 Stage 13 要量的東西。
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import {
  checkText,
  parseQuery,
  rankHits,
  snippetAround,
  type CheckStatus,
  type QueryRoute,
} from '../domain/search/query.js';
import { openCaseDatabase, type DatabaseSync } from '../infrastructure/db/database.js';
import { readCase } from '../infrastructure/db/repositories/case-repo.js';
import { loadItems, type ItemRow } from '../infrastructure/db/repositories/item-repo.js';
import {
  bigramCandidates,
  entityCandidates,
  ftsCandidates,
  hasRunningRun,
  titleRanks,
  type IndexCandidate,
} from '../infrastructure/index/reader.js';
import { readDerived } from '../infrastructure/fs/case-files.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { correlationId } from '../shared/id.js';
import { err, ok, type Result } from '../shared/result.js';

const CASE_DB_FILE = 'case.sqlite';

/** 索引一次最多回幾個候選。 */
export const CANDIDATE_CAP = 400;
/** 其中最多讀幾份正文回來確認。**一份正文是一次檔案讀取。** */
export const VERIFY_CAP = 60;
/** 實體最多回幾個 —— 它們一定是精確命中，不設限會把整頁佔滿。 */
export const ENTITY_CAP = 10;
/** 預設回給前端幾筆。 */
export const DEFAULT_LIMIT = 30;

export type SearchMode = 'text' | 'semantic' | 'hybrid';

export interface SearchHit {
  readonly kind: 'item' | 'entity';
  readonly id: string;
  readonly title: string;
  /** `web`／`pdf`／`image`／`text`／`note`；實體是 `null`。 */
  readonly itemKind: string | null;
  /** 實體的型別；資料是 `null`。 */
  readonly entityType: string | null;
  readonly lang: string | null;
  readonly readAt: number | null;
  readonly excluded: boolean;
  /** `hit`／`miss`／`no-text` —— **`miss` 就是跨詞誤中**。 */
  readonly check: CheckStatus;
  readonly snippet: string;
  readonly matchStart: number;
  readonly matchEnd: number;
  readonly cutHead: boolean;
  readonly cutTail: boolean;
}

export interface SearchResponse {
  readonly query: string;
  readonly mode: SearchMode;
  readonly route: QueryRoute;
  readonly hits: readonly SearchHit[];
  /** 索引給了幾個候選（上限 `CANDIDATE_CAP`）。 */
  readonly candidates: number;
  /** 其中讀了幾份正文回來確認。 */
  readonly checked: number;
  /** 確認過的有幾個 —— **它跟 `hits.length` 不一樣，而差額正是誤中。** */
  readonly verified: number;
  /**
   * `SEARCH_INDEX_INCOMPLETE`／`SEARCH_EMBED_UNAVAILABLE`。
   * **notice 不是 error**：結果照常回，只是要說出它可能不完整。
   */
  readonly notices: readonly string[];
  readonly tookMs: number;
}

/**
 * 兩個來源的候選合併。**輪流取，不是排在一起比大小。**
 *
 * bigram 的分數是次數總和，FTS5 的是 `-bm25` —— 兩個數字的單位完全不同，
 * 放在同一個 `ORDER BY` 裡比大小是一個**看起來會動、而且永遠偏袒其中一邊**的錯。
 * 輪流取保證兩條路都有機會進入「要驗的那 60 個」。
 *
 * 回傳的 `score` 換成各自來源裡的名次（1 → 0），**它是排序線索，不是相關度**。
 */
function interleave(
  a: readonly IndexCandidate[],
  b: readonly IndexCandidate[],
  cap: number,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  const rank = (list: readonly IndexCandidate[], i: number): number =>
    list.length <= 1 ? 1 : 1 - i / list.length;

  for (let i = 0; i < Math.max(a.length, b.length) && out.size < cap; i++) {
    const fromA = a[i];
    if (fromA !== undefined && !out.has(fromA.id)) out.set(fromA.id, rank(a, i));
    if (out.size >= cap) break;
    const fromB = b[i];
    if (fromB !== undefined && !out.has(fromB.id)) out.set(fromB.id, rank(b, i));
  }
  return out;
}

/**
 * 一份資料的正文。
 *
 * 點註沒有 `derived/`（它不是抓回來的東西）—— 它的引文與內文寫在 `excerpt`，
 * 而那正是 `note-service` 送進索引的同一份字串。**所以驗的是同一段字。**
 */
async function textOf(folder: string, item: ItemRow): Promise<string | null> {
  if (item.kind === 'note')
    return item.excerpt.length > 0 ? `${item.title}\n${item.excerpt}` : null;
  const derived = await readDerived(folder, item.id);
  if (derived === null) return null;
  // **標題在前面** —— 索引寫進去的就是這個順序（`indexText`），
  // 而順序一致才能用位置判斷「命中在標題裡」。
  return `${derived.title}\n${derived.text}`;
}

export async function searchCase(
  dataRoot: string,
  slug: string,
  input: { readonly q: string; readonly mode?: SearchMode; readonly limit?: number },
): Promise<Result<SearchResponse>> {
  const cid = correlationId();
  const started = Date.now();

  const parsed = parseQuery(input.q);
  if (parsed === null) return err('SEARCH_QUERY_EMPTY', cid, {});

  const mode: SearchMode = input.mode ?? 'text';
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 100));

  const folder = join(casesDir(dataRoot), slug);

  // **先看資料夾在不在。** `new DatabaseSync(path)` 對一個不存在的目錄會丟例外，
  // 而那個例外會變成 500 —— 打錯一個 slug 拿到「伺服器內部錯誤」是一句錯話，
  // 那是 404。（`case-service` 早就這樣擋，其餘幾支還沒有。）
  try {
    await access(join(folder, CASE_DB_FILE));
  } catch {
    return err('CASE_NOT_FOUND', cid, { slug });
  }

  const opened = await openCaseDatabase(join(folder, CASE_DB_FILE), {
    backupDir: backupsDir(dataRoot),
    backupLabel: slug,
  });
  if (opened.kind === 'schema-too-new')
    return err('CASE_SCHEMA_TOO_NEW', cid, { found: opened.found });
  if (opened.kind === 'migrate-failed') return err('CASE_SCHEMA_MIGRATE_FAILED', cid, { slug });

  const db: DatabaseSync = opened.db;
  let items: readonly ItemRow[];
  let scores: ReadonlyMap<string, number>;
  let ranks: ReadonlyMap<string, string>;
  let entities: readonly SearchHit[];
  let incomplete: boolean;
  try {
    if (readCase(db) === null) return err('CASE_NOT_FOUND', cid, { slug });

    const fromBigram = bigramCandidates(db, parsed.grams, CANDIDATE_CAP);
    const fromFts = parsed.phrase === null ? [] : ftsCandidates(db, parsed.phrase, CANDIDATE_CAP);
    scores = interleave(fromBigram, fromFts, CANDIDATE_CAP);

    const ids = [...scores.keys()];
    items = loadItems(db, ids.slice(0, VERIFY_CAP));
    ranks = titleRanks(db, ids.slice(0, VERIFY_CAP));

    // **實體不必驗** —— `instr` 本身就是精確的子字串比對，
    // 而實體沒有正文可以回去看：它只有一個名字。
    entities = entityCandidates(db, parsed.raw, ENTITY_CAP).map((e) => ({
      kind: 'entity' as const,
      id: e.id,
      title: e.name,
      itemKind: null,
      entityType: e.type,
      lang: null,
      readAt: null,
      excluded: false,
      check: 'hit' as const,
      snippet: e.name,
      matchStart: 0,
      matchEnd: e.name.length,
      cutHead: false,
      cutTail: false,
    }));

    incomplete = hasRunningRun(db);
  } finally {
    db.close();
  }

  // ── 正文確認。**這一段是檔案讀取，所以它在資料庫關掉之後跑。** ──
  const byId = new Map(items.map((i) => [i.id, i]));
  const checked: {
    hit: SearchHit;
    status: CheckStatus;
    inTitle: boolean;
    indexScore: number;
    titleRank: string;
    id: string;
  }[] = [];

  for (const [id, score] of scores) {
    const item = byId.get(id);
    if (item === undefined) continue; // 超過 VERIFY_CAP 的那些沒有載進來
    const text = await textOf(folder, item);
    const result = checkText(text, parsed.raw);
    const snippet =
      result.span !== null && text !== null
        ? snippetAround(text, result.span)
        : {
            text: item.excerpt.slice(0, 160),
            matchStart: 0,
            matchEnd: 0,
            cutHead: false,
            cutTail: item.excerpt.length > 160,
          };

    checked.push({
      id,
      status: result.status,
      // 標題在正文前面，所以命中位置落在標題長度之內就是標題命中。
      inTitle: result.span !== null && result.span.start <= item.title.length,
      indexScore: score,
      titleRank: ranks.get(id) ?? '',
      hit: {
        kind: 'item',
        id,
        title: item.title,
        itemKind: item.kind,
        entityType: null,
        lang: item.lang,
        readAt: item.readAt,
        excluded: item.status === 'excluded',
        check: result.status,
        snippet: snippet.text,
        matchStart: snippet.matchStart,
        matchEnd: snippet.matchEnd,
        cutHead: snippet.cutHead,
        cutTail: snippet.cutTail,
      },
    });
  }

  const rankedItems = rankHits(checked).map((c) => c.hit);
  const hits = [...entities, ...rankedItems].slice(0, limit);

  const notices: string[] = [];
  if (incomplete) notices.push('SEARCH_INDEX_INCOMPLETE');
  // **語意那一半還沒接。** 要求它的時候不假裝有，也不整個失敗 ——
  // 全文照常回，並且說出語意沒跑（`api-contract.md`）。
  if (mode !== 'text') notices.push('SEARCH_EMBED_UNAVAILABLE');

  return ok(
    {
      query: parsed.raw,
      mode,
      route: parsed.route,
      hits,
      candidates: scores.size,
      checked: checked.length,
      verified: checked.filter((c) => c.status === 'hit').length + entities.length,
      notices,
      tookMs: Date.now() - started,
    },
    cid,
  );
}
