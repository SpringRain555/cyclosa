/**
 * 後端 API 的薄封裝。
 *
 * **後端只送碼，訊息在前端查表** —— 這樣「同一個碼在兩個地方有兩種說法」
 * 就不可能發生（`i18n/zh-TW.ts` 是唯一來源）。
 */
import { errorMessages, t } from './i18n/zh-TW';

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly correlationId: string;
  readonly detail?: Record<string, unknown>;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

function toError(body: unknown): ApiError {
  const b = (body ?? {}) as Record<string, unknown>;
  const code = typeof b['code'] === 'string' ? b['code'] : 'IO_UNEXPECTED';
  return {
    code,
    message: errorMessages[code] ?? t.error.unknown,
    correlationId: typeof b['correlationId'] === 'string' ? b['correlationId'] : '',
    ...(typeof b['detail'] === 'object' && b['detail'] !== null
      ? { detail: b['detail'] as Record<string, unknown> }
      : {}),
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      // **沒有 body 就不要宣告 content-type。**
      // 宣告了 `application/json` 卻送空 body，Fastify 會直接回
      // 「Body cannot be empty」—— 而那會變成一個 500，
      // 讓「排除」「復原」「重試」這幾個不需要參數的動作全部壞掉。
      // 2026-09-07 手動驗收時撞到的，三個按鈕一起。
      headers: {
        ...(init?.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    // 連不到 server —— 多半是它剛結束了
    return {
      ok: false,
      error: { code: 'IO_UNEXPECTED', message: t.error.unknown, correlationId: '' },
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    // 回應不是 JSON —— 多半是靜態檔的 SPA 後備被打到了
    return toResult<T>(res.ok, null);
  }
  return toResult<T>(res.ok && (body as { ok?: boolean }).ok === true, body);
}

function toResult<T>(succeeded: boolean, body: unknown): ApiResult<T> {
  if (succeeded) return { ok: true, data: (body as { data: T }).data };
  return { ok: false, error: toError(body) };
}

export interface CaseStats {
  itemCount: number;
  noteCount: number;
  entityCount: number;
  edgeCount: number;
  pendingNamedEdgeCount: number;
  lastRunAt: number | null;
}

export interface CaseSummary {
  slug: string;
  name: string;
  seed: string | null;
  status: 'new' | 'collecting' | 'ready' | 'archived';
  stats: CaseStats;
  updatedAt: number;
  folder: string;
}

export interface DataRootInfo {
  dataRoot: string;
  pointerPath: string;
}

/** 對外抓取的規矩。**數字從程式讀**，畫面不自己寫一份。 */
export interface FetchPolicy {
  intervalMs: number;
  minIntervalMs: number;
  intervalSource: 'default' | 'env';
  maxRetries: number;
  backOffMs: number[];
  maxRetryAfterMs: number;
}

/**
 * 刪除之前要先看見的東西。**`done` 是 false 的那一次一個檔都沒動** ——
 * 那一次回的是「你按下去會失去什麼」。
 */
export interface CaseDeletion {
  name: string;
  stats: CaseStats;
  /** 整個專題資料夾的大小，**含 `sources\` 的快照** —— 那通常是大部分。 */
  bytes: number;
  done: boolean;
  movedTo: string | null;
}

export type ItemStatus = 'pending' | 'fetched' | 'parsed' | 'included' | 'excluded' | 'failed';

export interface Item {
  id: string;
  kind: 'web' | 'pdf' | 'image' | 'text' | 'paper' | 'note';
  title: string;
  requestedUrl: string | null;
  sourceUrl: string | null;
  lang: string;
  sha256: string | null;
  sourceExt: string | null;
  mime: string | null;
  byteSize: number | null;
  fetchedAt: number | null;
  status: ItemStatus;
  lowConfidence: boolean;
  lowConfidenceReasons: string[];
  excerpt: string;
  extractorVersion: number | null;
  pageCount: number | null;
  imageWidth: number | null;
  imageHeight: number | null;
  errorCode: string | null;
  readAt: number | null;
  runId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ItemPage {
  items: Item[];
  nextCursor: string | null;
}

export interface DerivedPayload {
  extractorVersion: number;
  kind: 'web' | 'pdf' | 'image' | 'text';
  title: string;
  text: string;
  html: string | null;
  pages: string[] | null;
  excerpt: string;
  lowConfidence: boolean;
  reasons: string[];
}

export interface ItemDetail {
  item: Item;
  neighbours: { previous: string | null; next: string | null };
  position: { index: number; total: number };
}

export interface RunItem {
  id: string;
  runId: string;
  requested: string;
  host: string | null;
  itemId: string | null;
  outcome: 'queued' | 'running' | 'ok' | 'duplicate' | 'failed' | 'skipped' | 'cancelled';
  code: string | null;
  newNodes: number;
  newEdges: number;
  waitedMs: number | null;
  at: number | null;
}

/** 「全部標成未讀」的回應。**`done: false` 那一次什麼都沒改。** */
export interface ReadReset {
  read: number;
  cleared: number;
  done: boolean;
}

export interface Run {
  id: string;
  kind: 'import' | 'expand';
  status: 'queued' | 'running' | 'done' | 'partial' | 'cancelled' | 'failed';
  label: string;
  total: number;
  succeeded: number;
  failed: number;
  errorCode: string | null;
  /**
   * 取消是誰按的。**`null` ＝ 使用者自己按的**，那是絕大多數。
   *
   * `'shutdown'` ＝ 關閉程式時一起停的、`'stale'` ＝ 上一次沒有正常關閉。
   * 三者的 `status` 都是 `cancelled`，而畫面要說得出差別。
   */
  endedReason: 'shutdown' | 'stale' | null;
  correlationId: string;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  live: boolean;
  /** 暫停中。**執行時的事實，資料庫裡沒有它。** */
  paused: boolean;
  // ── 擴展才有的───────────────────────────────
  /** 匯入沒有主題，所以是 `null` */
  topic: string | null;
  /** `{"chat":"…","agent":"…"}` 的 JSON 字串 */
  providers: string | null;
  requests: number;
  /** **`null` 與 0 是兩件事**：本機模型真的是 0，沒回報的是不知道 */
  costUsd: number | null;
}

// ── 擴展──────────────────────────────────────────

export interface AngleSeed {
  id: string;
  title: string;
}

export interface Angle {
  id: string;
  ord: number;
  question: string;
  stance: string;
  /**
   * 這條角度是從既有的哪幾份長出來的。
   *
   * **設計稿在這裡寫的是「預估會找到幾個」**，而那個數字只可能是模型猜的。
   * 這一欄是查得到也驗得了的，而且它說的是「這條角度憑什麼被提出來」。
   */
  seeds: AngleSeed[];
  selected: boolean;
  foundUrls: number;
  newNodes: number;
  newEdges: number;
  code: string | null;
}

export interface ExpansionStart {
  runId: string;
  topic: string;
  angles: Angle[];
  /** 有幾份既有內容被拿去歸納視角。**0 代表這個專題是空的** */
  seededFrom: number;
}

// ── provider──────────────────────────────────────

export type ProviderRole = 'agent' | 'chat' | 'embed';

export interface ProviderCapabilities {
  browse: boolean;
  tools: boolean;
  json_schema: boolean;
  vision: boolean;
  context_tokens: number;
}

/** `chat` 走哪一種協定。**server 的 `ChatTransport` 也有一份**（兩份建置）。 */
export type ChatTransport = 'ollama' | 'openai';

/**
 * 「符合 schema」由誰保證。**server 的 `JsonMode` 也有一份**（兩份建置）。
 *
 * `checkedAt` 是 `null` 的時候不是量出來的 —— 協定本身保證（本機 Ollama），或還沒量。
 */
export interface JsonModeReport {
  mode: 'schema' | 'object' | 'none' | 'unchecked';
  checkedAt: number | null;
  detail: string;
}

export interface ProviderStatus {
  readonly version?: string | null;
  readonly auth?: 'none' | 'env-set' | 'env-missing';
  role: ProviderRole;
  configured: string;
  state: 'ready' | 'not-configured' | 'unreachable';
  detail: string;
  capabilities: ProviderCapabilities;
  /** 只有 `chat` 有；其餘兩個角色是 `null` */
  transport: ChatTransport | null;
  /** 只有 `chat` 有；其餘兩個角色是 `null` */
  jsonMode: JsonModeReport | null;
}

/**
 * `chat` 底下的兩個任務。**這一組字串在 server 的 `domain/provider` 也有一份** ——
 * `tests/guards/chat-tasks.test.ts` 釘著兩邊一致（`web/` 與 server 是兩份建置）。
 */
export type ChatTask = 'angles' | 'extract';

/**
 * **這個工具會用到模型的全部四個地方。**
 *
 * server 的 `domain/provider/capabilities.ts` 有 `MODEL_TASKS` 那一份定義，
 * 這裡是抄的（`web/` 與 server 是兩份建置，型別跨不過去）——
 * `tests/guards/chat-tasks.test.ts` 釘著兩邊一致。
 */
export type ModelTask = 'find-sources' | ChatTask | 'embed';

export interface ProvidersPayload {
  statuses: ProviderStatus[];
  /**
   * `chat` 端點上真的有的模型。**`null` 代表列不出來**，不是「一個都沒有」。
   * 從哪裡列取決於傳輸：Ollama 問 `/api/tags`，OpenAI 相容端點問 `/models`。
   */
  chatModels: string[] | null;
  /**
   * `embed` 端點（本機 Ollama）上的模型。**v0.18.0 之前它跟 `chatModels` 是同一份**，
   * 而 chat 一換成線上端點，嵌入的下拉選單就會列出線上模型。
   */
  embedModels: string[] | null;
  /** 每個 chat 任務**實際會跑在哪個模型上**，以及那個模型的狀態 */
  chatTasks: {
    task: ChatTask;
    model: string;
    overridden: boolean;
    state: ProviderStatus['state'];
    capabilities: ProviderCapabilities;
    /** **按模型而異**，所以每一列各自帶 */
    jsonMode: JsonModeReport | null;
  }[];
  config: {
    version: 1;
    chat: {
      transport: ChatTransport;
      baseUrl: string;
      model: string;
      apiKeyEnv: string | null;
      /** 逐任務覆寫。**空字串 ＝ 跟著 `model`**，不是「沒有模型」 */
      taskModels: Record<ChatTask, string>;
    } | null;
    /** `model` 走 CLI 的 `--model`。**空字串 ＝ 不帶，用 CLI 自己的預設** */
    agent: { command: string; args: string[]; model: string } | null;
    /** **沒有 apiKeyEnv** —— 嵌入只接本機端點，理由見 `providers/config.ts` */
    embed: { baseUrl: string; model: string } | null;
  };
  readiness: { role: ProviderRole; ok: boolean; missing: string[] }[];
  /**
   * 逐任務的同一件事，**四個任務全部都有**。
   *
   * 角色層那一格算的是「底下每一個任務都過得了嗎」，
   * 而使用者要修的時候需要知道**是哪一個任務、跑在哪個模型上、缺什麼**。
   */
  taskReadiness: {
    task: ModelTask;
    role: ProviderRole;
    model: string;
    overridden: boolean;
    ok: boolean;
    missing: string[];
  }[];
}

/** 搜尋模式。**server 的 `SearchMode` 也有一份**（兩份建置）。 */
export type SearchMode = 'text' | 'semantic' | 'hybrid';

/** 回填一批向量之後的報告（`POST /api/cases/:slug/embed`）。 */
export interface BackfillReport {
  /** **`null` ＝ 還沒設定嵌入模型**，那時候其餘欄位都是 0 */
  model: string | null;
  processed: number;
  written: number;
  /** 做完這一批之後還差幾份。**0 才是做完** */
  remaining: number;
  rows: number;
  owners: number;
  otherModels: { model: string; rows: number }[];
  code: string | null;
}

export interface ProviderTest {
  role: ProviderRole;
  ok: boolean;
  code: string | null;
  costUsd: number | null;
  elapsedMs: number;
  /** 線上端點按這顆按鈕會重量一次，所以這一格是剛量出來的結果 */
  jsonMode: JsonModeReport | null;
}

// ── 圖 ──────────────────────────────────────────────────────
//
// **`node` 這個字只在明確指「圖上的一個點」時才用**（glossary）——
// 這幾個型別就是那個情形。`link` 一律不用，一律 `edge`。

export type EdgeLayer = 'derived' | 'named' | 'comention' | 'similarity';
export type EdgeStatus = 'pending' | 'confirmed' | 'rejected';
export type ConfidenceTier = 'weak' | 'medium' | 'strong';

/** 檢索的一筆。**`check` 是三種狀態，不是一個布林值**（`search-service.ts`）。 */
export interface SearchHit {
  kind: 'item' | 'entity';
  id: string;
  title: string;
  itemKind: string | null;
  entityType: string | null;
  lang: string | null;
  readAt: number | null;
  excluded: boolean;
  /** `hit` 正文裡真的有 · `miss` 跨詞誤中 · `no-text` 正文讀不到、沒驗 */
  /**
   * `hit`／`semantic`／`miss`／`no-text`。
   *
   * **`semantic` 不是 `miss`**：語意那一路命中的文件本來就不會有那串字。
   */
  check: 'hit' | 'semantic' | 'miss' | 'no-text';
  snippet: string;
  matchStart: number;
  matchEnd: number;
  cutHead: boolean;
  cutTail: boolean;
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  route: 'bigram' | 'fts' | 'both';
  hits: SearchHit[];
  candidates: number;
  checked: number;
  verified: number;
  notices: string[];
  tookMs: number;
}

export interface SubgraphNode {
  id: string;
  kind: 'item' | 'entity';
  /** `item.kind` 或 `entity.type` */
  subKind: string;
  title: string;
  /** 離焦點幾跳 */
  hop: number;
  lang: string | null;
  readAt: number | null;
  excluded: boolean;
  lowConfidence: boolean;
  excerpt: string;
  mentionCount: number | null;
  /** 摺進這個節點的轉載數（「＋3 轉載」）*/
  derivedFolded: number;
  hollow: boolean;
}

export interface SubgraphEdge {
  id: string;
  source: string;
  target: string;
  layer: EdgeLayer;
  rel: string;
  status: EdgeStatus;
  origin: 'machine' | 'human';
  /** **只用於排序與線寬 —— 永遠不顯示成小數** */
  confidence: number;
  tier: ConfidenceTier;
  evidenceCount: number;
  independentSourceCount: number;
  hasDirectQuote: boolean;
  previouslyRejected: boolean;
  /** 共同提及線中點那個方塊是哪個實體 */
  via: string | null;
  /** 投影出來的，**資料庫裡沒有這一列** */
  synthetic: boolean;
  dashed: boolean;
  crossed: boolean;
  directional: boolean;
  folded: boolean;
}

export interface Subgraph {
  focus: string;
  hops: number;
  nodes: SubgraphNode[];
  edges: SubgraphEdge[];
  visibleNodeCount: number;
  totalNodeCount: number;
  totalEdgeCount: number;
  budget: number;
  overBudget: boolean;
  thresholds: { minToDraw: number; minToExpand: number };
}

export interface HopCounts {
  counts: Record<string, number>;
  budget: number;
  overBudget: string[];
  /** 這幾格的數字是**下界**（走訪在硬上限停了）。畫面上要顯示「8000+」 */
  capped: string[];
}

// ── 關聯與裁決────────────────────────────────────

/** 六條轉移的動作名稱。**改判是雙向的，所以只有五個動詞。** */
export type EdgeAction = 'confirm' | 'reject' | 'withdraw' | 'reclassify' | 'restore';

export interface EvidenceView {
  id: string;
  itemId: string;
  /** **面板上不出現 id** —— 使用者不認得它 */
  itemTitle: string;
  quote: string;
  charStart: number;
  charEnd: number;
  createdAt: number;
}

export interface AuditView {
  fromStatus: string;
  toStatus: string;
  action: string;
  /** `machine` 只有一種情形：墓碑例外讓一條否決過的邊復活（ADR-0016）*/
  actor: 'human' | 'machine';
  at: number;
}

export type Calibration =
  | { kind: 'insufficient-sample'; sampleSize: number }
  | { kind: 'ok'; sampleSize: number; confirmedRate: number; rejectedRate: number };

export interface EdgeDetail {
  id: string;
  layer: EdgeLayer;
  rel: string;
  source: string;
  sourceTitle: string;
  target: string;
  targetTitle: string;
  status: EdgeStatus;
  origin: 'machine' | 'human';
  tier: ConfidenceTier;
  evidenceCount: number;
  independentSourceCount: number;
  hasDirectQuote: boolean;
  previouslyRejected: boolean;
  createdAt: number;
  evidence: EvidenceView[];
  audit: AuditView[];
  /** 現在按得下去的動作。**空陣列代表這條邊不進裁決** */
  actions: EdgeAction[];
  adjudicable: boolean;
  /**
   * 面板上哪幾欄有意義。**規則在 `domain/graph/render-rules.ts`，不在元件裡** ——
   * 有些欄位在某些列上永遠是同一個值（`status` 永遠 `pending`、
   * 人建的邊的 `confidence` 永遠是 1），顯示它們會讓結構性的值
   * 看起來像測量結果。
   */
  fields: {
    status: boolean;
    tier: boolean;
    evidenceFacts: boolean;
    adjudication: boolean;
  };
  /** 「確認」按不下去，因為它是機器建的而且一筆出處都沒有 */
  confirmNeedsEvidence: boolean;
  calibration: Calibration;
}

export interface QueueEntry {
  id: string;
  rel: string;
  source: string;
  sourceTitle: string;
  target: string;
  targetTitle: string;
  tier: ConfidenceTier;
  previouslyRejected: boolean;
}

/**
 * **佇列不帶校準比例，而那是刻意的。**
 * 校準比例是分段的（ADR-0017：段 ＝ `rel` × 可信度等級），
 * 所以它只在「某一條邊」的脈絡下有意義 —— 它在 `EdgeDetail` 裡。
 */
export interface QueuePayload {
  total: number;
  entries: QueueEntry[];
}

const enc = encodeURIComponent;

export interface NoteRow {
  readonly id: string;
  readonly itemId: string | null;
  readonly body: string;
  readonly selectorJson: string;
  readonly snapshotSha256: string | null;
  readonly anchorOk: boolean;
  readonly mdPath: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** 錨點現在解到哪裡。**位置是算出來的，後端不存它。** */
export type AnchorHit =
  | {
      readonly kind: 'exact' | 'shifted';
      readonly start: number;
      readonly end: number;
      readonly page: number | null;
    }
  | { readonly kind: 'rect'; readonly rect: { x: number; y: number; w: number; h: number } }
  | { readonly kind: 'not-found' };

export interface ResolvedNote {
  readonly note: NoteRow;
  readonly hit: AnchorHit;
  readonly quote: string;
  readonly targetTitle: string | null;
  readonly edgeCount: number;
}

export interface CreatedNote {
  readonly note: ResolvedNote;
  readonly notice: string | null;
}

export interface RebuildReport {
  readonly items: number;
  readonly reextracted: number;
  readonly failed: number;
  readonly snapshotMissing: number;
  readonly notes: {
    readonly checked: number;
    readonly exact: number;
    readonly shifted: number;
    readonly unresolved: number;
  };
}

export interface SiteHistory {
  readonly attempts: number;
  readonly byAccess: Readonly<Record<string, number>>;
  readonly lastAt: number | null;
  readonly lastCode: string | null;
}

export interface SourceRow {
  readonly host: string;
  readonly nameZh: string;
  readonly kind: 'api' | 'site';
  readonly category: string;
  readonly probe: string | null;
  readonly noteZh: string;
  readonly enabled: boolean;
  readonly builtIn: boolean;
  readonly discovered: boolean;
  readonly expected: 'open' | 'login' | 'mixed' | null;
  readonly history: SiteHistory;
  readonly lastProbe: { access: string; code: string | null; at: number; url: string } | null;
  readonly verdict: {
    readonly access: string;
    readonly basis: 'history' | 'probe' | 'none';
    readonly at: number | null;
    readonly attempts: number;
  };
  readonly preference: 'prefer' | 'neutral' | 'deprioritise';
}

export interface EntitySide {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly aliases: readonly string[];
  readonly mentions: number;
}

export interface MergeCandidate {
  readonly keep: EntitySide;
  readonly merge: EntitySide;
  readonly reason: 'same-key' | 'alias' | 'parenthetical';
}

export interface MergeResult {
  readonly keptId: string;
  readonly mergedId: string;
  readonly movedEdges: number;
  readonly duplicateEdges: number;
}

export interface UndoReport {
  runId: string;
  deletedItems: number;
  deletedEdges: number;
  deletedEntities: number;
  keptItems: number;
  keptEdges: number;
  keptAsEvidence: number;
  /** 有東西被留下來。**畫面上要說出這件事。** */
  partial: boolean;
}

export interface ShutdownState {
  activeRuns: number;
  shuttingDown: boolean;
}

export interface ExportSummary {
  /** 匯出到哪。**畫面要顯示它** —— 不然使用者找不到剛剛產生的檔案。 */
  folder: string;
  files: string[];
  nodeCount: number;
  edgeCount: number;
  noteCount: number;
  sourceCount: number;
  quoteCount: number;
  verified: number;
  shifted: number;
  missing: number;
  projectedOmitted: number;
  /** 有引文回溯不到。**檔案照樣產生，而且在檔案裡標明了。** */
  notice: string | null;
}

export const api = {
  dataRoot: () => request<DataRootInfo>('/api/system/data-root'),
  fetchPolicy: () => request<FetchPolicy>('/api/system/fetch-policy'),
  setDataRoot: (dataRoot: string) =>
    request<DataRootInfo>('/api/system/data-root', {
      method: 'POST',
      body: JSON.stringify({ dataRoot }),
    }),
  cases: () => request<CaseSummary[]>('/api/cases'),
  createCase: (name: string, seed?: string) =>
    request<CaseSummary>('/api/cases', {
      method: 'POST',
      body: JSON.stringify(seed === undefined ? { name } : { name, seed }),
    }),
  /**
   * 換一個資料根，**既有的東西跟著搬過去**。
   *
   * 與 `setDataRoot` 是兩件事：那一支是「還沒有的時候指一個」，
   * 這一支是「已經有了，連同裡面的東西換個地方」。
   */
  moveDataRoot: (dataRoot: string) =>
    request<DataRootInfo>('/api/system/data-root/move', {
      method: 'POST',
      body: JSON.stringify({ dataRoot }),
    }),
  /**
   * 重建範例專案。已經有一份的時候回 `CASE_NAME_DUPLICATE` ——
   * **重建不該悄悄產生第二份。**
   */
  rebuildSample: () =>
    request<{ slug: string; items: number; entities: number; edges: number }>(
      '/api/system/sample',
      { method: 'POST' },
    ),
  setCaseStatus: (slug: string, action: 'archive' | 'reopen') =>
    request<string>(`/api/cases/${enc(slug)}/status`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
  /**
   * 刪除專題。**兩段式** —— `confirmName` 是 `null` 只回「你會失去什麼」，
   * 一個檔都不動；帶了名字才真的刪，而且名字要逐字對得上（比對在伺服器端）。
   */
  deleteCase: (slug: string, confirmName: string | null) =>
    request<CaseDeletion>(`/api/cases/${enc(slug)}/delete`, {
      method: 'POST',
      body: JSON.stringify(confirmName === null ? {} : { confirmName }),
    }),

  // ── 匯入 ────────────────────────────────────────────────
  importUrls: (slug: string, urls: string[]) =>
    request<{ runId: string; total: number }>(`/api/cases/${enc(slug)}/import/urls`, {
      method: 'POST',
      body: JSON.stringify({ urls }),
    }),

  /**
   * 上傳一個檔案。**原始位元組直接送**，檔名走標頭 ——
   * 沒有 multipart 套件，也就不必為了拖一個檔案多一個會解析外部輸入的依賴。
   */
  importFile: (slug: string, file: File) =>
    request<{ runId: string; itemId: string | null; code: string | null }>(
      `/api/cases/${enc(slug)}/import/file`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-file-name': encodeURIComponent(file.name),
        },
        body: file,
      },
    ),

  // ── 作業紀錄 ────────────────────────────────────────────
  runs: (slug: string) => request<Run[]>(`/api/cases/${enc(slug)}/runs`),
  run: (slug: string, runId: string) =>
    request<{ run: Run; items: RunItem[]; angles: Angle[] }>(
      `/api/cases/${enc(slug)}/runs/${enc(runId)}`,
    ),
  cancelRun: (slug: string, runId: string) =>
    request<true>(`/api/cases/${enc(slug)}/runs/${enc(runId)}/cancel`, { method: 'POST' }),
  runEventsUrl: (slug: string, runId: string) =>
    `/api/cases/${enc(slug)}/runs/${enc(runId)}/events`,

  // ── 擴展──────────────────────────────────────
  //
  // **兩支端點，中間有一個人。** `startExpansion` 回的是子問題清單，
  // 而它**不會開始抓** —— 那一步是 REQ-0004 的驗收條件，不是 UI 糖。
  startExpansion: (slug: string, topic: string) =>
    request<ExpansionStart>(`/api/cases/${enc(slug)}/runs`, {
      method: 'POST',
      body: JSON.stringify({ topic }),
    }),
  chooseAngles: (slug: string, runId: string, angles: string[]) =>
    request<{ runId: string; total: number }>(`/api/cases/${enc(slug)}/runs/${enc(runId)}/angles`, {
      method: 'POST',
      body: JSON.stringify({ angles }),
    }),

  // ── provider ────────────────────────────────────────────
  providers: () => request<ProvidersPayload>('/api/providers'),
  saveProviders: (config: ProvidersPayload['config']) =>
    request<ProvidersPayload>('/api/providers', {
      method: 'POST',
      body: JSON.stringify(config),
    }),
  testProvider: (role: ProviderRole) =>
    request<ProviderTest>('/api/providers/test', {
      method: 'POST',
      body: JSON.stringify({ role }),
    }),

  /**
   * 改名。**回的 `slug` 是新的** —— 呼叫端要拿它去換網址，
   * 不然改完名之後每一個連結都會 404。
   */
  renameCase: (slug: string, name: string) =>
    request<CaseSummary>(`/api/cases/${enc(slug)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  // ── 資料節點與閱讀器 ────────────────────────────────────
  items: (slug: string, query: Record<string, string>) =>
    request<ItemPage>(`/api/cases/${enc(slug)}/items?${new URLSearchParams(query).toString()}`),
  item: (slug: string, itemId: string) =>
    request<ItemDetail>(`/api/cases/${enc(slug)}/items/${enc(itemId)}`),
  itemContent: (slug: string, itemId: string) =>
    request<{ item: Item; derived: DerivedPayload | null }>(
      `/api/cases/${enc(slug)}/items/${enc(itemId)}/content`,
    ),
  snapshotUrl: (slug: string, itemId: string) =>
    `/api/cases/${enc(slug)}/items/${enc(itemId)}/snapshot`,
  markRead: (slug: string, itemId: string, read: boolean) =>
    request<number | null>(`/api/cases/${enc(slug)}/items/${enc(itemId)}/read`, {
      method: 'POST',
      body: JSON.stringify({ read }),
    }),
  itemAction: (slug: string, itemId: string, action: 'exclude' | 'restore' | 'retry') =>
    request<unknown>(`/api/cases/${enc(slug)}/items/${enc(itemId)}/${action}`, { method: 'POST' }),

  /**
   * 整個專題全部標成未讀。**兩段式，門在伺服器端**（同 `shutdown`）：
   * 不帶 `force` 只回「有幾份標著已讀」，帶了才真的清。
   */
  clearAllRead: (slug: string, force: boolean) =>
    request<ReadReset>(`/api/cases/${enc(slug)}/items/unread-all`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),

  // ── 圖 ──────────────────────────────────────────────────
  //
  // **沒有 `graph(slug)`。** 不是「有但不建議用」，是不存在（ADR-0008）——
  // 有了它前端遲早會呼叫，然後在 8k 節點時死掉。

  /** 打開分頁時的起點。**它回一個焦點，不回一張圖。** */
  subgraphFocus: (slug: string) =>
    request<{ focus: string | null; totalNodeCount: number }>(
      `/api/cases/${enc(slug)}/subgraph/focus`,
    ),

  subgraph: (slug: string, query: Record<string, string>) =>
    request<Subgraph>(`/api/cases/${enc(slug)}/subgraph?${new URLSearchParams(query).toString()}`),

  /**
   * 檢索。**全文與語意是同一支端點的兩個 `mode`** ——
   * 「這次能不能用語意」的依據在伺服器那一邊（有沒有嵌入模型），
   * 分成兩支的話前端要自己猜那件事。
   */
  /** 補一批向量。**回 `remaining`，呼叫端看它決定要不要再打一次。** */
  embedBackfill: (slug: string) =>
    request<BackfillReport>(`/api/cases/${enc(slug)}/embed`, { method: 'POST' }),
  search: (slug: string, q: string, mode: SearchMode = 'text') =>
    request<SearchResponse>(
      `/api/cases/${enc(slug)}/search?${new URLSearchParams({ q, mode }).toString()}`,
    ),

  /** **只數不拉資料** —— 工具列的跳數格在按下去之前就顯示代價。 */
  subgraphSize: (slug: string, query: Record<string, string>) =>
    request<HopCounts>(
      `/api/cases/${enc(slug)}/subgraph/size?${new URLSearchParams(query).toString()}`,
    ),

  // ── 關聯與裁決 ──────────────────────────────────────────
  //
  // **沒有「機器提出一條邊」的函式。** 那條路只有擴展作業走得到，
  // 而它在伺服器端 —— 前端能呼叫的話，墓碑與出處要求就有一條繞道。

  edge: (slug: string, edgeId: string) =>
    request<EdgeDetail>(`/api/cases/${enc(slug)}/edges/${enc(edgeId)}`),

  /** **一建立就是「已確認」＋ `origin=human`。** 出處就是那個人。 */
  createEdge: (
    slug: string,
    body: { source: string; target: string; rel: string; layer?: string },
  ) =>
    request<EdgeDetail>(`/api/cases/${enc(slug)}/edges`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  /** **六條轉移都走這一支。** */
  transitionEdge: (slug: string, edgeId: string, action: EdgeAction) =>
    request<EdgeDetail>(`/api/cases/${enc(slug)}/edges/${enc(edgeId)}/transition`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),

  /** 還在等人判斷的。**只有具名關係。** */
  queue: (slug: string) => request<QueuePayload>(`/api/cases/${enc(slug)}/queue`),

  // ── 筆記與點註 ──────────────────────────────────────────

  /** **只送位置，不送引文** —— 引文由後端從 `derived/` 切（note-service）。 */
  createNote: (
    slug: string,
    itemId: string,
    input: {
      body: string;
      start?: number;
      end?: number;
      page?: number;
      rect?: { x: number; y: number; w: number; h: number };
    },
  ) =>
    request<CreatedNote>(`/api/cases/${enc(slug)}/items/${enc(itemId)}/notes`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  itemNotes: (slug: string, itemId: string) =>
    request<ResolvedNote[]>(`/api/cases/${enc(slug)}/items/${enc(itemId)}/notes`),
  notes: (slug: string) => request<ResolvedNote[]>(`/api/cases/${enc(slug)}/notes`),
  updateNote: (slug: string, noteId: string, body: string) =>
    request<CreatedNote>(`/api/cases/${enc(slug)}/notes/${enc(noteId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    }),
  deleteNote: (slug: string, noteId: string) =>
    request<{ id: string; removedEdges: number }>(`/api/cases/${enc(slug)}/notes/${enc(noteId)}`, {
      method: 'DELETE',
    }),
  rebuild: (slug: string) =>
    request<RebuildReport>(`/api/cases/${enc(slug)}/rebuild`, { method: 'POST' }),

  // ── 來源網站與實體對齊─────────────────────

  sources: () => request<SourceRow[]>('/api/sources'),
  saveSource: (input: Partial<SourceRow> & { host: string }) =>
    request<SourceRow[]>('/api/sources', { method: 'POST', body: JSON.stringify(input) }),
  removeSource: (host: string) =>
    request<SourceRow[]>(`/api/sources/${enc(host)}`, { method: 'DELETE' }),
  /** **會送出真的請求** —— 走同一條擷取管線。 */
  checkSources: (hosts?: string[]) =>
    request<SourceRow[]>('/api/sources/check', {
      method: 'POST',
      body: JSON.stringify(hosts === undefined ? {} : { hosts }),
    }),

  mergeCandidates: (slug: string) =>
    request<MergeCandidate[]>(`/api/cases/${enc(slug)}/entities/merges`),
  mergeEntities: (slug: string, keptId: string, mergedId: string) =>
    request<MergeResult>(`/api/cases/${enc(slug)}/entities/merge`, {
      method: 'POST',
      body: JSON.stringify({ keptId, mergedId }),
    }),
  unmergeEntity: (slug: string, entityId: string) =>
    request<{ restored: number }>(`/api/cases/${enc(slug)}/entities/${enc(entityId)}/unmerge`, {
      method: 'POST',
    }),

  // ── 作業的控制 ──────────────────────────────────────────

  /** **暫停不是取消**：正在做的那一項會做完，然後停在項與項之間。 */
  pauseRun: (slug: string, runId: string) =>
    request<true>(`/api/cases/${enc(slug)}/runs/${enc(runId)}/pause`, { method: 'POST' }),
  resumeRun: (slug: string, runId: string) =>
    request<true>(`/api/cases/${enc(slug)}/runs/${enc(runId)}/resume`, { method: 'POST' }),
  /** **跟取消是兩件事。** 取消是「別再做下去了」，復原是「當作沒發生」。 */
  undoRun: (slug: string, runId: string) =>
    request<UndoReport>(`/api/cases/${enc(slug)}/runs/${enc(runId)}/undo`, { method: 'POST' }),

  /**
   * 結束 Cyclosa。**兩段式** —— 不帶 `force` 只回「有幾個作業在跑」，
   * 帶了才真的關。那道門在伺服器端，不是只在畫面上。
   */
  shutdown: (force = false) =>
    request<ShutdownState>('/api/system/shutdown', {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),

  // ── 證據包匯出───────────────────────────────

  /**
   * **參數跟 `subgraph` 那一支一模一樣** —— 匯出的就是你現在看到的那一塊。
   * `nodeIds` 沒送代表整塊；送一個空陣列是「一個都沒選」，那是一個錯誤。
   */
  exportEvidence: (slug: string, query: Record<string, string>, nodeIds?: string[]) =>
    request<ExportSummary>(`/api/cases/${enc(slug)}/export/evidence`, {
      method: 'POST',
      body: JSON.stringify(nodeIds === undefined ? query : { ...query, nodeIds }),
    }),
};
