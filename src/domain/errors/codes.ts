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
  /**
   * 改名時資料夾搬不動。
   *
   * **不是 `IO_UNEXPECTED`** —— 那個碼的意思是「不知道發生什麼事」，
   * 而這個知道：**有東西正開著那個資料夾。** 最常見的是這個工具自己
   * （匯入或擴展正在跑，資料庫是開的），其次是檔案總管停在那一層。
   *
   * 兩者對使用者是同一件事：**關掉再試一次**，而那正是訊息要說的。
   */
  CASE_RENAME_BLOCKED: 'error',
  /**
   * 刪除時打的名字跟專題名對不起來。
   *
   * **這不是驗證失敗，這是那道門本身。** 刪除的守門就是「逐字打對」，
   * 而那個比對**在伺服器端** —— 只在畫面上比的話，那是一個繞得過的提醒。
   */
  CASE_NAME_MISMATCH: 'error',
  /**
   * 現在這個狀態做不了這個動作。
   *
   * **與 `CASE_ARCHIVED` 分開，因為那個碼會說謊**：作業還在跑的時候按封存，
   * 舊的實作回的是「這個專題已封存」—— 而它明明沒有。
   */
  CASE_STATUS_INVALID: 'error',
  /**
   * 刪除時資料夾搬不進 `backups\`。
   *
   * 與 `CASE_RENAME_BLOCKED` 同一個成因（有東西開著那個資料夾），
   * **而使用者要做的事不同**：改名失敗是「關掉再試」，
   * 刪除失敗要多說一句「那個專題還在，沒有被刪掉一半」。
   */
  CASE_DELETE_BLOCKED: 'error',
  CASE_SCHEMA_TOO_NEW: 'error',
  CASE_SCHEMA_MIGRATE_FAILED: 'error',
  CASE_UNEXPECTED: 'error',

  // ── IO_* 檔案系統與資料根 ────────────────────────────────
  IO_POINTER_MISSING: 'error',
  IO_POINTER_MALFORMED: 'error',
  IO_DATA_ROOT_MISSING: 'error',
  IO_DATA_ROOT_NOT_WRITABLE: 'error',
  /**
   * 有作業在跑，資料根不准搬。
   *
   * 搬家會把 `case.sqlite` 從一個正在寫它的行程底下抽走。
   * **這個碼帶著「幾個作業」** —— 因為使用者的下一步是去看那幾個作業。
   */
  IO_DATA_ROOT_BUSY: 'error',
  /**
   * 要搬過去的那個位置不能用。`detail.reason` 分三種：
   * `same`（跟現在同一個）、`nested`（在現在這個底下，搬進去會變成搬進自己）、
   * `not-empty`（那裡已經有東西，蓋過去會毀掉別人的資料）。
   */
  IO_DATA_ROOT_TARGET_INVALID: 'error',
  /** 資料根搬不動 —— 有東西開著它。**資料完整留在原地。** */
  IO_DATA_ROOT_MOVE_BLOCKED: 'error',
  IO_DISK_FULL: 'error',
  IO_SNAPSHOT_MISSING: 'partial',
  IO_SNAPSHOT_CORRUPT: 'error',
  IO_UNEXPECTED: 'error',
  /**
   * **畫面連不到 Cyclosa 自己的伺服器**（v0.24.3）。只有前端會產生這個碼：`fetch` 本身失敗，
   * 伺服器根本沒有回話。
   *
   * 2026-09-19 之前這個情況用的是 `IO_UNEXPECTED` 的訊息 ——「請把下面的識別碼交出來」，
   * 而下面沒有識別碼（伺服器沒回話，哪來的識別碼），也沒說伺服器已經不在了。
   * 使用者看到的是一句要他交出一個不存在的東西的話。
   */
  IO_SERVER_UNREACHABLE: 'error',

  // ── FETCH_* 擷取 ─────────────────────────────────────────
  /** 貼進來的東西根本不是一個 http／https 網址。**這是輸入問題，不是網路問題。** */
  FETCH_BAD_URL: 'partial',
  /**
   * 這份內容已經在專題裡了（SHA-256 相同）。
   *
   * **notice 而不是 partial** —— 什麼都沒有失敗，
   * 而且它正是「同一個檔案匯入兩次只會有一個節點」這條規則在運作的證據。
   */
  FETCH_DUPLICATE: 'notice',
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
  /**
   * 對方回的是一張**反爬蟲的驗證頁**，不是內容。
   *
   * **不是 `FETCH_LOGIN_REQUIRED`** —— 那一句叫人去登入或訂閱，
   * 而這一種登入了也一樣：它擋的是「你是程式」，不是「你沒有權限」。
   * 給使用者的下一步也不同：自己用瀏覽器打開、把那一頁存下來再匯入。
   *
   * **也不是 `FETCH_HTTP_4XX`** —— 這種頁多半回 200（`domain/ingest/challenge.ts`）。
   */
  FETCH_BOT_CHALLENGE: 'partial',
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
  /**
   * 模型給的引文**在原文裡找不到**。
   *
   * 不是 `PROVIDER_OUTPUT_UNPARSEABLE` —— 那份輸出解析得很成功，
   * 它只是**在講一句原文沒有講過的話**。而那正是這個工具唯一不能容忍的錯：
   * 一個指不到原文的出處，比沒有出處更糟，因為它看起來已經被驗過了。
   *
   * `partial`：一條抽壞了不該讓整批擴展失敗。
   */
  PROVIDER_QUOTE_NOT_FOUND: 'partial',
  PROVIDER_SANDBOX_VIOLATION: 'error',
  PROVIDER_EMBED_MODEL_MISMATCH: 'error',
  /**
   * 端點收到了請求、**但拒絕了金鑰**（HTTP 401／403）。
   *
   * 不是 `PROVIDER_UNREACHABLE` —— 那一句叫人去檢查「它是不是沒開」，
   * 而它明明開著、而且回了話。「連不上」與「連得上但不讓你進」的下一步完全不同。
   */
  PROVIDER_AUTH_REJECTED: 'error',
  /**
   * 端點說太多請求了（HTTP 429），**而且照它說的等過、再試了兩次還是 429**
   * （`domain/provider/rate-limit.ts`，SDK 式退避）。2026-09-13 之前是「立刻停不重試」。
   */
  PROVIDER_RATE_LIMITED: 'error',
  /**
   * 這個模型在這個端點上**連「回一份 JSON」都不保證**。
   *
   * 量測是按「端點＋模型」記的，而 2026-09-11 在真的端點上觸發這一條的
   * 是一個**嵌入模型** —— OpenAI 相容端點的 `/models` 會把它一起列出來，
   * 而它根本不能對話。所以訊息說「這個模型」，不說「這個端點」。
   *
   * `json_schema` 與 `json_object` 兩種模式都量過而且都不成立。需要結構化輸出的任務
   * （角度、抽取）在它上面跑不了 —— **這一條是停手，不是降級**：
   * 從散文裡撈 JSON 會在模型換一種寫法時安靜地少撈幾條。
   */
  PROVIDER_JSON_UNSUPPORTED: 'error',
  /**
   * 回了一份 JSON，**但形狀不符合這個任務的 schema**。
   *
   * 不是 `PROVIDER_OUTPUT_UNPARSEABLE` —— 那一份解析得很成功。
   * 這一條只會在端點不保證 schema、由這一側事後驗證的時候出現：
   * 形狀不對的一律擋下來，**不交出一份沒有被限制過的輸出**
   * （`expansion-prompts.ts` 檔頭三層防護的第二層）。
   */
  PROVIDER_OUTPUT_SCHEMA_MISMATCH: 'partial',
  PROVIDER_UNEXPECTED: 'error',

  // ── RUN_* 作業本身 ───────────────────────────────────────
  RUN_NOT_FOUND: 'error',
  /**
   * 想復原一次**還在跑的**作業。
   *
   * 一邊寫一邊刪會留下一個誰都說不清楚的狀態，
   * 而使用者要做的事很明確：**先取消，或等它跑完。**
   */
  RUN_STILL_ACTIVE: 'error',
  RUN_UNEXPECTED: 'error',

  // ── GRAPH_* 圖與裁決 ─────────────────────────────────────
  GRAPH_EVIDENCE_REQUIRED: 'error',
  GRAPH_HUMAN_ROW_IMMUTABLE: 'error',
  GRAPH_TOMBSTONED: 'notice',
  GRAPH_TRANSITION_INVALID: 'error',
  /**
   * 想裁決一條**下次重算就會被蓋掉**的邊（open-questions Q6）。
   *
   * 不是「這個動作不合法」（那是 `GRAPH_TRANSITION_INVALID`）——
   * 動作本身在轉移表上，是**這條邊不該被裁決**。
   */
  GRAPH_LAYER_NOT_ADJUDICABLE: 'error',
  GRAPH_NODE_NOT_FOUND: 'error',
  GRAPH_EDGE_NOT_FOUND: 'error',
  /** 這兩個節點之間已經有一條同樣關係型別的邊了。**衝突不是格式錯 → 409。** */
  GRAPH_EDGE_EXISTS: 'error',
  GRAPH_AUDIT_APPEND_ONLY: 'error',
  /** 手動建立具名關係，但沒有寫關係型別。**一條沒有名字的具名關係不是主張。** */
  GRAPH_REL_EMPTY: 'error',
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
    code === 'GRAPH_REL_EMPTY' ||
    code === 'SEARCH_QUERY_EMPTY' ||
    code === 'EXPORT_EMPTY_SELECTION'
  ) {
    return 400;
  }
  if (code.endsWith('_UNEXPECTED') || code.startsWith('IO_')) return 500;
  return 409;
}
