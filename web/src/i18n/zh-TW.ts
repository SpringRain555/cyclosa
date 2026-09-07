/**
 * **所有 UI 字串的唯一來源。**
 *
 * 一條測試掃 `web/src/`，在 `i18n/` 以外出現中文字面值就紅（REQ-0007）。
 *
 * **為什麼一個只有一種語言的專案還要 i18n 檔**：不是為了以後加語言
 * （介面多語是「刻意不做」），是為了**讓所有字串有一個地方可以一起看** ——
 * 用詞一致、語氣一致、錯誤訊息與畫面上的說法對得起來。
 * 散在 40 個元件裡的中文，沒有人能一次看完。
 */

/**
 * 錯誤碼 → 繁中訊息。
 *
 * **每個碼都要有一則，而且要說「使用者該做什麼」**（REQ-0008）。
 * 成因寫在 `docs/architecture/error-codes.md`，這裡只放對使用者說的那一句。
 *
 * **UI 只顯示這裡的訊息，碼只進日誌。**
 */
export const errorMessages: Readonly<Record<string, string>> = {
  // ── 專題 ──────────────────────────────────────────────
  CASE_NOT_FOUND:
    '找不到這個專題的資料夾。它可能被搬走或刪掉了 —— 用「開啟既有資料夾」重新指到它。',
  CASE_NAME_EMPTY: '請輸入專題名稱。',
  CASE_NAME_DUPLICATE: '已經有同名的專題了。換一個名稱，或直接開啟既有的那一個。',
  CASE_FOLDER_EXISTS:
    '那個位置已經有一個同名資料夾，但它不是一個專題。換一個名稱，或用「開啟既有資料夾」。',
  CASE_ARCHIVED: '這個專題已封存，不能改動。要繼續的話先重新開啟它。',
  CASE_SCHEMA_TOO_NEW: '這個專題被較新版本的 Cyclosa 寫過。請先升級 —— 用舊版繼續開會寫壞資料。',
  CASE_SCHEMA_MIGRATE_FAILED: '資料庫升級失敗，已經回復到升級前的狀態。請把下面的識別碼交出來。',
  CASE_UNEXPECTED: '專題操作出了預期外的問題。請把下面的識別碼交出來。',

  // ── 檔案系統與資料根 ──────────────────────────────────
  IO_POINTER_MISSING: '還沒有設定資料要放哪裡。請選一個資料夾，之後的專題都會建在那底下。',
  IO_POINTER_MALFORMED: '記錄資料位置的檔案內容不正確。可以刪掉它重新選一次，或手動修好。',
  IO_DATA_ROOT_MISSING:
    '設定裡記的資料夾現在找不到。如果它在外接磁碟上，接回來再試一次；或重新選一個位置。',
  IO_DATA_ROOT_NOT_WRITABLE: '那個資料夾存在，但寫不進去。檢查它的權限，或換一個位置。',
  IO_DISK_FULL: '磁碟空間不足。清出空間再試一次 —— 已經寫進去的資料不會壞。',
  IO_SNAPSHOT_MISSING:
    '這一項的原始快照檔不見了，閱讀器打不開它。可以重新擷取，但原有的點註會標成「找不到原文位置」。',
  IO_SNAPSHOT_CORRUPT:
    '原始快照的內容跟當初存下來的不一樣 —— 快照本來不應該被改動。請確認是不是同步軟體或防毒動過它。',
  IO_UNEXPECTED: '存取檔案時出了預期外的問題。請把下面的識別碼交出來。',

  // ── 擷取 ──────────────────────────────────────────────
  FETCH_BAD_URL: '這不是一個網址。檢查看看是不是少了開頭的 https://，或貼到的是一段文字。',
  FETCH_DUPLICATE: '這一份已經在專題裡了，所以沒有再建一個節點。',
  FETCH_ROBOTS_DISALLOWED:
    '這個網站的 robots.txt 不允許抓取這一頁，所以跳過了。需要的話請自己開瀏覽器讀，再把內容貼進來。',
  FETCH_RATE_LIMITED:
    '對方限流了，已經立刻停止而且不會重試。過一段時間再試 —— 同一個網域的其他項目也一起停了。',
  FETCH_TIMEOUT: '連線逾時。可以重試這一項；反覆逾時通常是對方的問題。',
  FETCH_DNS: '找不到這個網域。檢查網址有沒有打錯，或網路是不是斷了。',
  FETCH_TLS: '這個網站的憑證驗證不通過，所以沒有抓。這個工具不提供忽略憑證的選項。',
  FETCH_HTTP_4XX: '對方回覆找不到或拒絕存取。404 通常是頁面沒了，403 常見於需要登入。',
  FETCH_HTTP_5XX: '對方的伺服器出錯了。稍後重試這一項。',
  FETCH_TOO_LARGE: '這個檔案超過單檔上限，跳過了。真的需要的話請自己下載後用檔案匯入。',
  FETCH_UNSUPPORTED_TYPE: '不支援這種檔案型別。目前支援網頁、Markdown、純文字、PDF 與圖片。',
  FETCH_LOGIN_REQUIRED:
    '這一頁需要登入或訂閱才能看。這個工具不會繞過登入與付費牆 —— 請自己登入後另存再匯入。',
  FETCH_UNEXPECTED: '擷取時出了預期外的問題。請把下面的識別碼交出來。',

  // ── 抽取 ──────────────────────────────────────────────
  PARSE_EMPTY_CONTENT: '抽不到正文。可以看「原始快照」確認那一頁本來就有沒有內容。',
  PARSE_JS_ONLY:
    '這一頁的內容要靠瀏覽器執行程式才會出現，靜態抓不到。目前不會交出一份空正文假裝它本來就沒東西。',
  PARSE_LOW_CONFIDENCE:
    '這一份的正文抽取信心較低，可能夾雜導覽或廣告。引用之前建議對一下原始快照。',
  PARSE_PDF_NO_TEXT_LAYER:
    '這份 PDF 沒有文字層（多半是掃描的），所以只能框選區域做註記，不能選文字。',
  PARSE_PDF_ENCRYPTED: '這份 PDF 有密碼或限制擷取。請自己解除之後再匯入。',
  PARSE_IMAGE_UNSUPPORTED: '這個圖片格式解不開。轉成 PNG、JPEG 或 WebP 再匯入。',
  PARSE_ENCODING: '這一份的文字編碼判不出來，正文可能有亂碼。可以用「原始快照」對照。',
  PARSE_UNEXPECTED: '解析內容時出了預期外的問題。請把下面的識別碼交出來。',

  // ── LLM 與嵌入 ────────────────────────────────────────
  PROVIDER_NOT_CONFIGURED: '這項功能需要的模型還沒有設定。到設定頁指定一個。',
  PROVIDER_CAPABILITY_MISSING:
    '目前設定的模型缺少這個任務需要的能力，所以停下來了。請換一個模型，或改用不需要那個能力的做法 —— 這個工具不會自動換一個能力較弱的來跑。',
  PROVIDER_UNREACHABLE: '連不上這個模型。檢查它是不是沒開，或指令不在系統路徑上。',
  PROVIDER_TIMEOUT: '這次作業逾時了。已經寫進去的節點與關聯都保留著，可以再跑一次補剩下的。',
  PROVIDER_BUDGET_EXCEEDED:
    '這次作業達到設定的用量上限。已寫入的都保留著；要繼續請調高上限再跑一次。',
  PROVIDER_OUTPUT_UNPARSEABLE:
    '模型的回覆解析不出來，這一項跳過了，其餘照常。反覆發生通常代表這個模型不適合這個任務。',
  PROVIDER_SANDBOX_VIOLATION:
    '偵測到模型在自己的工作目錄裡留下抓取產物，作業已經停下來。所有抓取都必須走同一條擷取管線。請把下面的識別碼交出來。',
  PROVIDER_EMBED_MODEL_MISMATCH:
    '要比對的向量是另一個嵌入模型產生的，所以停下來了。請換回原本的模型，或重新計算這個專題的向量 —— 硬比會得到一個看起來正常的錯答案。',
  PROVIDER_UNEXPECTED: '模型呼叫出了預期外的問題。請把下面的識別碼交出來。',

  // ── 圖與裁決 ──────────────────────────────────────────
  GRAPH_EVIDENCE_REQUIRED:
    '這條關聯沒有任何引文，不能標成已確認。請先補一筆出處，或改成自己手動建立一條。',
  GRAPH_HUMAN_ROW_IMMUTABLE:
    '有東西試圖修改你手動建立的關聯，已經擋下來了。請把下面的識別碼交出來。',
  GRAPH_TOMBSTONED:
    '這條關聯你先前否決過，所以不會再放進待查證。若之後出現新的出處，它會帶著「曾被否決」的標記重新出現。',
  GRAPH_TRANSITION_INVALID: '這個狀態變更不被允許。請把下面的識別碼交出來。',
  GRAPH_NODE_NOT_FOUND: '找不到這個節點，它可能已經被刪掉了。回專題清單重新進來。',
  GRAPH_SELF_EDGE: '不能把一個節點連到它自己。請選兩個不同的節點。',
  GRAPH_SUBGRAPH_TOO_LARGE: '這個範圍太大了。請縮小跳數，或加上篩選條件。',
  GRAPH_SUBGRAPH_TIMEOUT: '查詢這個範圍花太久了。請縮小跳數或加上篩選條件。',
  GRAPH_UNEXPECTED: '圖的操作出了預期外的問題。請把下面的識別碼交出來。',

  // ── 筆記與點註 ────────────────────────────────────────
  NOTE_ANCHOR_UNRESOLVED: '找不到這則註記在原文裡的位置。註記內容還在，可以手動重新指定位置。',
  NOTE_TARGET_MISSING: '這則註記指向的資料已經不在了。註記本身仍然保存在 notes 資料夾裡。',
  NOTE_MD_WRITE_FAILED: '註記已經存進資料庫，但那份純文字副本寫不出去。檢查資料夾的權限。',
  NOTE_UNEXPECTED: '註記操作出了預期外的問題。請把下面的識別碼交出來。',

  // ── 檢索 ──────────────────────────────────────────────
  SEARCH_QUERY_EMPTY: '請輸入要找的內容。',
  SEARCH_INDEX_INCOMPLETE: '還有項目正在建立索引，結果可能不完整。等匯入跑完再查一次。',
  SEARCH_EMBED_UNAVAILABLE:
    '語意搜尋目前不可用（模型沒開或沒設定）。全文搜尋不受影響，仍然照常運作。',
  SEARCH_UNEXPECTED: '搜尋時出了預期外的問題。請把下面的識別碼交出來。',

  // ── 證據包匯出 ────────────────────────────────────────
  EXPORT_EMPTY_SELECTION: '還沒有選任何東西。先在圖上框選一塊再匯出。',
  EXPORT_TARGET_NOT_WRITABLE: '這個位置寫不進去。換一個資料夾。',
  EXPORT_EVIDENCE_MISSING: '選取範圍裡有幾條關聯的引文回溯不到原始資料，它們會在匯出的檔案裡標明。',
  EXPORT_UNEXPECTED: '匯出時出了預期外的問題。請把下面的識別碼交出來。',
};

/** 畫面上的字。**元件裡不寫中文，一律從這裡取。** */
export const t = {
  app: {
    name: 'Cyclosa',
    tagline: '從一個點，長成一張帶出處的網',
  },
  nav: {
    allCases: '全部專題',
    graph: '關聯圖',
    reader: '閱讀器',
    runs: '作業紀錄',
    settings: '設定',
  },
  caseList: {
    title: '專題',
    newCase: '新增專題',
    openExisting: '開啟既有資料夾',
    hint: '一個專題是一個資料夾。整個搬走、備份、丟給別人，都是搬那一個資料夾。',
    stats: {
      cases: '專題',
      nodes: '節點總數',
      pending: '待查證的關聯',
      snapshots: '快照佔用',
    },
    columns: {
      name: '專題',
      status: '狀態',
      items: '資料節點',
      entities: '實體',
      edges: '關聯',
      pending: '待查證',
      lastRun: '最後擴展',
      folder: '資料夾',
      open: '匯入',
    },
    empty: {
      title: '還沒有專題',
      body: '專題是這裡的工作單位。丟一個主題、一個人、一件事，或一整個資料夾進去，Cyclosa 會把它們編成一張帶出處的關聯網。',
      cta: '建立第一個專題',
      willCreateIn: '會建在',
    },
    rootIs: '專題根目前是',
    rootChangeable: '，可在設定改。程式與資料是分開的。',
    never: '尚未擴展',
  },
  createCase: {
    title: '新增專題',
    nameLabel: '專題名稱',
    namePlaceholder: '例如：蓬萊塵蛛的網上裝飾行為',
    seedLabel: '起點（選填）',
    seedPlaceholder: '一個主題、人物、事件，或先留空',
    submit: '建立',
    cancel: '取消',
  },
  setup: {
    title: '先決定資料放哪裡',
    body: '專題資料庫、原始快照、筆記與日誌都會存在這個資料夾底下，跟程式分開。這樣程式可以公開，而你蒐集的東西不會。',
    pathLabel: '資料根目錄',
    submit: '就用這裡',
    pointerNote: '這個位置會記在',
  },
  caseStatus: {
    new: '新建',
    collecting: '蒐集中',
    ready: '已就緒',
    archived: '已封存',
  },
  error: {
    title: '出了問題',
    copyId: '複製識別碼',
    copied: '已複製',
    retry: '重試',
    unknown: '發生了未知的錯誤。請把下面的識別碼交出來。',
    pointerPath: '設定檔位置',
    dataRoot: '它指到',
  },
  itemStatus: {
    pending: '待處理',
    fetched: '已擷取',
    parsed: '已解析',
    included: '已納入',
    excluded: '已排除',
    failed: '失敗',
  },

  /** 一次作業的五種收尾狀態。**「部分失敗」不是「失敗」的一種。** */
  runStatus: {
    queued: '排隊中',
    running: '執行中',
    done: '已完成',
    partial: '部分失敗',
    cancelled: '已取消',
    failed: '失敗',
  },

  /** 作業裡單一項目的結果。 */
  runOutcome: {
    queued: '等待中',
    running: '進行中',
    ok: '已寫入',
    duplicate: '已存在',
    failed: '失敗',
    skipped: '略過',
    cancelled: '已取消',
  },

  /**
   * 抽取信心低的理由。
   *
   * **每一條都對得上 2026-09-07 那次 34 個真實頁面的量測**，
   * 所以這裡的說法要講得出「我們看到了什麼」，不是「它可能不好」。
   */
  lowConfidenceReason: {
    'readability-failed': '抽取器完全找不到正文',
    'too-short': '抽出來的正文很短',
    'link-heavy': '抽出來的內容大部分是連結 —— 這通常是列表頁或導覽頁',
    'thin-vs-html': '正文只佔原始網頁的一小部分 —— 可能要 JavaScript 才看得到內容',
    'pdf-no-text-layer': '這份 PDF 沒有文字層（掃描件）',
  },

  reader: {
    tab: '閱讀器',
    listTitle: '這個專題裡的資料',
    empty: '這個專題還沒有任何資料。到「作業紀錄」貼一個網址或拖一個檔案進來。',
    pickOne: '從左邊選一份來讀。',
    position: '第 {index} 份，共 {total} 份',
    previous: '上一份',
    next: '下一份',
    sortRecent: '最近匯入',
    sortTitle: '依標題',
    filterAll: '全部',
    filterLowConfidence: '只看低信心',
    filterUnread: '只看未讀',
    loadMore: '載入更多',
    source: '來源',
    fetchedAt: '快照時間',
    language: '語言',
    unknownLanguage: '判不出來',
    size: '大小',
    pages: '共 {n} 頁',
    page: '第 {n} 頁',
    openSnapshot: '看原始快照',
    original: '原文',
    translated: '繁體中文',
    noTranslation: '這一份還沒有譯文。',
    markRead: '標記為已讀',
    markUnread: '標記為未讀',
    read: '已讀',
    exclude: '排除這一份',
    restore: '復原',
    retry: '重試',
    excluded: '這一份已被排除，不會出現在圖上。',
    failedNotice: '這一份沒有抽取成功。原始快照還在，可以直接看它。',
    noContent: '沒有重構後的正文。原始快照還在。',
    imageOnly: '這是一張圖片。',
    noTextLayer: '這份 PDF 沒有文字層，只能框選區域。**不是工具壞了。**',
    lowConfidenceTitle: '這份正文可能抽壞了',
  },

  runs: {
    tab: '作業紀錄',
    title: '作業紀錄',
    empty: '還沒有任何作業。貼一個網址或拖一個檔案進來就會開始。',
    newImport: '匯入',
    urlsLabel: '貼上網址（一行一個）',
    urlsPlaceholder: 'https://example.com/一篇文章',
    submitUrls: '開始匯入',
    dropHint: '或把檔案拖到這裡（網頁存檔、Markdown、純文字、PDF、圖片）',
    picking: '選一個檔案',
    uploading: '上傳中…',
    cancel: '取消這次作業',
    live: '執行中',
    counts: '成功 {succeeded}、失敗 {failed}，共 {total} 項',
    colStatus: '狀態',
    colSource: '來源',
    colHost: '網域',
    colNodes: '新增節點',
    colEdges: '新增關聯',
    colNote: '備註',
    waited: '等了 {ms} 毫秒',
    openItem: '開啟',
    /** **這一列一直在畫面上**，因為它是這個工具對外的行為承諾。 */
    throttleTitle: '對外抓取的規矩',
    throttleInterval: '同網域間隔 3 秒',
    throttleBackoff: '收到 429／503 立即停不重試',
    throttleRobots: '遵守 robots.txt',
    throttleNow: '正在等 {host}（{ms} 毫秒）',
  },

  common: {
    loading: '載入中…',
    close: '關閉',
    back: '返回',
  },
} as const;

/** 把 `{name}` 換成值。**訊息本身仍然只在這個檔案裡。** */
export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}
