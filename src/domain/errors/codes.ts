/**
 * 錯誤碼的**單一真實來源**。
 *
 * `docs/architecture/error-codes.md` 是這一份的說明，
 * `web/src/i18n/zh-TW.ts` 是它們的繁中訊息 ——
 * **三者由 tests/guards/error-codes.test.ts 守著，任一邊多一個少一個就紅。**
 *
 * 級別的意思（REQ-0008）：
 *   error   這件事做不成
 *   partial **單項失敗，整批繼續** —— run 進「部分失敗」，其餘照常寫入
 *   notice  不是失敗，但使用者需要知道
 *
 * **`partial` 是一等公民，不是「失敗」的一種。**
 * 一批 40 個 URL 有 3 個 404，其餘 37 個的內容不該跟著消失。
 */

export const ERROR_LEVELS = ['error', 'partial', 'notice'] as const;
export type ErrorLevel = (typeof ERROR_LEVELS)[number];

/**
 * 碼 → 級別。**加碼要同時改 error-codes.md 與 i18n，否則測試會紅。**
 * 那條測試存在的理由就是這個表會漂。
 */
export const ERROR_CODES = {
  // ── CASE_* 專題 ──────────────────────────────────────────
  CASE_NOT_FOUND: 'error',
  CASE_NAME_EMPTY: 'error',
  CASE_NAME_DUPLICATE: 'error',
  CASE_FOLDER_EXISTS: 'error',
  CASE_ARCHIVED: 'error',
  CASE_SCHEMA_TOO_NEW: 'error',
  CASE_SCHEMA_MIGRATE_FAILED: 'error',
  CASE_UNEXPECTED: 'error',

  // ── IO_* 檔案系統與資料根 ────────────────────────────────
  IO_POINTER_MISSING: 'error',
  IO_POINTER_MALFORMED: 'error',
  IO_DATA_ROOT_MISSING: 'error',
  IO_DATA_ROOT_NOT_WRITABLE: 'error',
  IO_DISK_FULL: 'error',
  IO_SNAPSHOT_MISSING: 'partial',
  IO_SNAPSHOT_CORRUPT: 'error',
  IO_UNEXPECTED: 'error',

  // ── FETCH_* 擷取 ─────────────────────────────────────────
  FETCH_ROBOTS_DISALLOWED: 'partial',
  FETCH_RATE_LIMITED: 'partial',
  FETCH_TIMEOUT: 'partial',
  FETCH_DNS: 'partial',
  FETCH_TLS: 'partial',
  FETCH_HTTP_4XX: 'partial',
  FETCH_HTTP_5XX: 'partial',
  FETCH_TOO_LARGE: 'partial',
  FETCH_UNSUPPORTED_TYPE: 'partial',
  FETCH_LOGIN_REQUIRED: 'partial',
  FETCH_UNEXPECTED: 'partial',

  // ── PARSE_* 抽取 ─────────────────────────────────────────
  PARSE_EMPTY_CONTENT: 'partial',
  PARSE_JS_ONLY: 'partial',
  PARSE_LOW_CONFIDENCE: 'notice',
  PARSE_PDF_NO_TEXT_LAYER: 'notice',
  PARSE_PDF_ENCRYPTED: 'partial',
  PARSE_IMAGE_UNSUPPORTED: 'partial',
  PARSE_ENCODING: 'partial',
  PARSE_UNEXPECTED: 'partial',

  // ── PROVIDER_* LLM 與嵌入 ────────────────────────────────
  PROVIDER_NOT_CONFIGURED: 'error',
  PROVIDER_CAPABILITY_MISSING: 'error',
  PROVIDER_UNREACHABLE: 'error',
  PROVIDER_TIMEOUT: 'partial',
  PROVIDER_BUDGET_EXCEEDED: 'partial',
  PROVIDER_OUTPUT_UNPARSEABLE: 'partial',
  PROVIDER_SANDBOX_VIOLATION: 'error',
  PROVIDER_EMBED_MODEL_MISMATCH: 'error',
  PROVIDER_UNEXPECTED: 'error',

  // ── GRAPH_* 圖與裁決 ─────────────────────────────────────
  GRAPH_EVIDENCE_REQUIRED: 'error',
  GRAPH_HUMAN_ROW_IMMUTABLE: 'error',
  GRAPH_TOMBSTONED: 'notice',
  GRAPH_TRANSITION_INVALID: 'error',
  GRAPH_NODE_NOT_FOUND: 'error',
  GRAPH_SELF_EDGE: 'error',
  GRAPH_SUBGRAPH_TOO_LARGE: 'error',
  GRAPH_SUBGRAPH_TIMEOUT: 'error',
  GRAPH_UNEXPECTED: 'error',

  // ── NOTE_* 筆記與點註 ────────────────────────────────────
  NOTE_ANCHOR_UNRESOLVED: 'notice',
  NOTE_TARGET_MISSING: 'error',
  NOTE_MD_WRITE_FAILED: 'partial',
  NOTE_UNEXPECTED: 'error',

  // ── SEARCH_* 檢索 ────────────────────────────────────────
  SEARCH_QUERY_EMPTY: 'error',
  SEARCH_INDEX_INCOMPLETE: 'notice',
  SEARCH_EMBED_UNAVAILABLE: 'notice',
  SEARCH_UNEXPECTED: 'error',

  // ── EXPORT_* 證據包匯出 ──────────────────────────────────
  EXPORT_EMPTY_SELECTION: 'error',
  EXPORT_TARGET_NOT_WRITABLE: 'error',
  EXPORT_EVIDENCE_MISSING: 'notice',
  EXPORT_UNEXPECTED: 'error',
} as const satisfies Record<string, ErrorLevel>;

export type ErrorCode = keyof typeof ERROR_CODES;

export const ALL_ERROR_CODES = Object.keys(ERROR_CODES) as ErrorCode[];

export function levelOf(code: ErrorCode): ErrorLevel {
  return ERROR_CODES[code];
}

/**
 * `partial` 的碼**不會讓整批失敗**。
 * 這支函式存在是為了讓那條規則有一個可以被呼叫、也可以被測試的地方 ——
 * 而不是散在每個 catch 裡靠人記得。
 */
export function failsWholeBatch(code: ErrorCode): boolean {
  return ERROR_CODES[code] === 'error';
}

/** HTTP 狀態碼對映。合約寫在 `docs/architecture/api-contract.md`。 */
export function httpStatusOf(code: ErrorCode): number {
  if (ERROR_CODES[code] !== 'error') return 200;
  if (code.endsWith('_NOT_FOUND')) return 404;
  if (code.endsWith('_TIMEOUT')) return 504;
  if (code === 'GRAPH_SUBGRAPH_TOO_LARGE' || code === 'FETCH_TOO_LARGE') return 413;
  // 400 只給**請求本身就不合法**的：空字串、自己連自己。
  // 「名稱重複」與「資料夾已存在」不是格式錯，是**跟既有狀態衝突** —— 那是 409。
  if (
    code === 'CASE_NAME_EMPTY' ||
    code === 'GRAPH_SELF_EDGE' ||
    code === 'SEARCH_QUERY_EMPTY' ||
    code === 'EXPORT_EMPTY_SELECTION'
  ) {
    return 400;
  }
  if (code.endsWith('_UNEXPECTED') || code.startsWith('IO_')) return 500;
  return 409;
}
