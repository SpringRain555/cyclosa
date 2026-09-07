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

const enc = encodeURIComponent;

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
    request<{ run: Run; items: RunItem[] }>(`/api/cases/${enc(slug)}/runs/${enc(runId)}`),
  cancelRun: (slug: string, runId: string) =>
    request<true>(`/api/cases/${enc(slug)}/runs/${enc(runId)}/cancel`, { method: 'POST' }),
  runEventsUrl: (slug: string, runId: string) =>
    `/api/cases/${enc(slug)}/runs/${enc(runId)}/events`,

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
};
