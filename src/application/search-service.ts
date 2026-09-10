/**
 * 檢索（Stage 12）。**三路候選、一次確認。**
 *
 * | 路 | 索引 | 什麼時候跑 |
 * |---|---|---|
 * | bigram | CJK 兩字一組 | `text`／`hybrid` |
 * | FTS5 | 拉丁 `unicode61` | `text`／`hybrid` |
 * | 向量 | 段落級嵌入 | `semantic`／`hybrid`，**而且要有設定好的嵌入模型** |
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

import { chunkText } from '../domain/search/chunk.js';
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
import { semanticCandidates } from '../infrastructure/index/vector-reader.js';
import { loadProviders, type Providers } from '../infrastructure/providers/registry.js';
import { readDerived } from '../infrastructure/fs/case-files.js';
import { backupsDir, casesDir } from '../infrastructure/fs/paths.js';
import { sweepStaleRuns } from './run-sweep.js';
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
  /**
   * `hit`／`semantic`／`miss`／`no-text`。
   *
   * **`miss` 是跨詞誤中**（正文裡真的沒有那串字）；
   * **`semantic` 不是** —— 它是語意那一路命中的，而那種命中
   * 本來就不會有那串字。兩者合成一個的話，畫面會對一個正確的結果
   * 說「可能是誤中」。
   */
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
 * 幾個來源的候選合併。**輪流取，不是排在一起比大小。**
 *
 * bigram 的分數是次數總和，FTS5 的是 `-bm25`，語意的是餘弦 ——
 * 三個數字的單位完全不同，放在同一個 `ORDER BY` 裡比大小是一個
 * **看起來會動、而且永遠偏袒其中一邊**的錯。
 * 輪流取保證每一條路都有機會進入「要驗的那 60 個」。
 *
 * 回傳的 `score` 換成各自來源裡的名次（1 → 0），**它是排序線索，不是相關度**。
 *
 * > **2026-09-10 從兩路擴成任意路。** 語意那一路接上來的時候，
 * > 第一個念頭是「餘弦是 0–1，正規化一下就可以跟別的加權平均」——
 * > 而那正是這段註解一開始在反對的事。**餘弦是 0–1 不代表它可比**：
 * > 0.7 的餘弦與「bigram 命中 7 次」之間沒有換算率，而任何一個權重
 * > 都是在替使用者決定「這次要偏語意還是偏字面」。
 * > 名次是每一路自己說得準的東西，所以合併發生在名次上。
 */
function interleave(
  lists: readonly (readonly IndexCandidate[])[],
  cap: number,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  const rank = (list: readonly IndexCandidate[], i: number): number =>
    list.length <= 1 ? 1 : 1 - i / list.length;
  const longest = Math.max(0, ...lists.map((l) => l.length));

  for (let i = 0; i < longest && out.size < cap; i++) {
    for (const list of lists) {
      if (out.size >= cap) break;
      const row = list[i];
      if (row !== undefined && !out.has(row.id)) out.set(row.id, rank(list, i));
    }
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
  load: () => Promise<Providers> = loadProviders,
): Promise<Result<SearchResponse>> {
  const cid = correlationId();
  const started = Date.now();

  const parsed = parseQuery(input.q);
  if (parsed === null) return err('SEARCH_QUERY_EMPTY', cid, {});

  const mode: SearchMode = input.mode ?? 'text';
  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 100));

  const folder = join(casesDir(dataRoot), slug);

  /**
   * **查詢的向量先要到手，那一步是網路、跟資料庫無關。**
   *
   * 放在開資料庫之前，是因為它可能要等幾百毫秒（甚至逾時）——
   * 而一個開著的 SQLite 連線在那段時間裡什麼事都沒做。
   *
   * 拿不到向量**不是錯誤**：全文那一半照常跑，然後在 `notices` 裡說出來。
   * ADR-0006 第 3 條要求的是「不靜默降級」，而這裡有兩個字是重點 ——
   * 降級可以，安靜不行。
   */
  let queryVector: Float32Array | null = null;
  let embedModel: string | null = null;
  if (mode !== 'text') {
    try {
      const provider = (await load()).embed;
      if (provider !== null) {
        const out = await provider.embedQuery(parsed.raw);
        if (out.kind === 'ok') {
          queryVector = out.value;
          embedModel = provider.model;
        }
      }
    } catch {
      // 設定檔壞掉、Ollama 沒開 —— 都走同一條路：全文照常，notice 說出來。
      queryVector = null;
    }
  }

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
  /** 語意那一路命中的是第幾段。**只有從那一路來的才有值。** */
  let semanticOrd: ReadonlyMap<string, number>;
  try {
    if (readCase(db) === null) return err('CASE_NOT_FOUND', cid, { slug });

    // **先掃掉上一次沒收尾的作業，再問「索引還在寫嗎」。**
    // 不掃的話，一個被強制結束留下來的 `running` 會讓底下的 `incomplete`
    // 永遠是 true —— 也就是**之後每一次搜尋**都掛一句「結果可能不完整」。
    sweepStaleRuns(db, slug);

    // **`semantic` 模式不跑字面那兩路。** 使用者要的就是「用字不同的那些」——
    // 混進字面命中會讓這個模式跟 `hybrid` 沒有差別，而那樣它就沒有存在的理由。
    const fromBigram = mode === 'semantic' ? [] : bigramCandidates(db, parsed.grams, CANDIDATE_CAP);
    const fromFts =
      mode === 'semantic' || parsed.phrase === null
        ? []
        : ftsCandidates(db, parsed.phrase, CANDIDATE_CAP);
    const fromVector =
      queryVector === null || embedModel === null
        ? []
        : semanticCandidates(db, queryVector, { model: embedModel, limit: CANDIDATE_CAP });

    scores = interleave([fromBigram, fromFts, fromVector], CANDIDATE_CAP);
    semanticOrd = new Map(fromVector.map((h) => [h.id, h.ord]));

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
    const literal = checkText(text, parsed.raw);

    /**
     * **語意那一路命中的那一段，要當成摘要顯示出來。**
     *
     * 這一段是 `check` 那三種狀態原本說不出來的事。語意命中的文件
     * **本來就不會有那串字**（那是它的用途），所以 `checkText` 回 `miss`——
     * 而畫面上寫的是「可能是誤中：正文裡沒有這串字」，
     * **對一個正確的結果指控它是誤中。**
     *
     * 所以：字面找得到就照舊（`hit` 優先，那是更強的證據）；
     * 找不到但它是語意來的，就標 `semantic` 並且把**那一段**切出來 ——
     * 段落的位置由 `chunkText` 重算，跟寫向量時是同一支函式，
     * 所以第 `ord` 段一定是同一段。
     */
    const ord = semanticOrd.get(id);
    const chunk =
      literal.status !== 'hit' && ord !== undefined && text !== null
        ? chunkText(text)[ord]
        : undefined;

    const result: { status: CheckStatus; span: { start: number; end: number } | null } =
      chunk !== undefined
        ? { status: 'semantic', span: { start: chunk.start, end: chunk.start } }
        : literal;

    const snippet =
      chunk !== undefined && text !== null
        ? // 段落本身就是摘要 —— **不再切一次**，因為切出來的那 96 個字
          // 未必包含它為什麼被選中的那一句。
          {
            text: text.slice(chunk.start, chunk.end),
            matchStart: 0,
            matchEnd: 0,
            cutHead: chunk.start > 0,
            cutTail: chunk.end < text.length,
          }
        : literal.span !== null && text !== null
          ? snippetAround(text, literal.span)
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
  // **要求了語意卻沒跑成，就要說出來。** 不假裝有，也不整個失敗 ——
  // 全文照常回，並且說出語意沒跑（`api-contract.md`）。
  // 沒設定模型、Ollama 沒開、模型拉掉了 —— 三種都走這一條。
  if (mode !== 'text' && queryVector === null) notices.push('SEARCH_EMBED_UNAVAILABLE');

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
