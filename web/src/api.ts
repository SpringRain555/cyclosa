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

export interface Run {
  id: string;
  kind: 'import' | 'expand';
  status: 'queued' | 'running' | 'done' | 'partial' | 'cancelled' | 'failed';
  label: string;
  total: number;
  succeeded: number;
  failed: number;
  errorCode: string | null;
  correlationId: string;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  live: boolean;
  // ── 擴展才有的（Stage 9）───────────────────────────────
  /** 匯入沒有主題，所以是 `null` */
  topic: string | null;
  /** `{"chat":"…","agent":"…"}` 的 JSON 字串 */
  providers: string | null;
  requests: number;
  /** **`null` 與 0 是兩件事**：本機模型真的是 0，沒回報的是不知道 */
  costUsd: number | null;
}

// ── 擴展（Stage 9）──────────────────────────────────────────

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

// ── provider（Stage 9）──────────────────────────────────────

export type ProviderRole = 'agent' | 'chat' | 'embed';

export interface ProviderCapabilities {
  browse: boolean;
  tools: boolean;
  json_schema: boolean;
  vision: boolean;
  context_tokens: number;
}

export interface ProviderStatus {
  role: ProviderRole;
  configured: string;
  state: 'ready' | 'not-configured' | 'unreachable';
  detail: string;
  capabilities: ProviderCapabilities;
}

export interface ProvidersPayload {
  statuses: ProviderStatus[];
  /** Ollama 上真的有的模型。**`null` 代表連不上**，不是「一個都沒有」 */
  chatModels: string[] | null;
  config: {
    version: 1;
    chat: { baseUrl: string; model: string } | null;
    agent: { command: string; args: string[] } | null;
  };
  readiness: { role: ProviderRole; ok: boolean; missing: string[] }[];
}

export interface ProviderTest {
  role: ProviderRole;
  ok: boolean;
  code: string | null;
  costUsd: number | null;
  elapsedMs: number;
}

// ── 圖 ──────────────────────────────────────────────────────
//
// **`node` 這個字只在明確指「圖上的一個點」時才用**（glossary）——
// 這幾個型別就是那個情形。`link` 一律不用，一律 `edge`。

export type EdgeLayer = 'derived' | 'named' | 'comention' | 'similarity';
export type EdgeStatus = 'pending' | 'confirmed' | 'rejected';
export type ConfidenceTier = 'weak' | 'medium' | 'strong';

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
}

// ── 關聯與裁決（Stage 8）────────────────────────────────────

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

export const api = {
  dataRoot: () => request<DataRootInfo>('/api/system/data-root'),
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
  setCaseStatus: (slug: string, action: 'archive' | 'reopen') =>
    request<string>(`/api/cases/${enc(slug)}/status`, {
      method: 'POST',
      body: JSON.stringify({ action }),
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

  // ── 擴展（Stage 9）──────────────────────────────────────
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

  /** **只數不拉資料** —— 工具列的跳數格在按下去之前就顯示代價。 */
  subgraphSize: (slug: string, query: Record<string, string>) =>
    request<HopCounts>(
      `/api/cases/${enc(slug)}/subgraph/size?${new URLSearchParams(query).toString()}`,
    ),

  // ── 關聯與裁決 ──────────────────────────────────────────
  //
  // **沒有「機器提出一條邊」的函式。** 那條路只有擴展作業走得到（Stage 9），
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
};
