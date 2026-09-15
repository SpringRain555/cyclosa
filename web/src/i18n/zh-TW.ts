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
    '找不到這個專題。它可能被搬走、改名或刪掉了 —— 回專題清單看看它還在不在。如果是你手動搬走的，把整個資料夾放回資料根的 cases 底下，清單就會再出現它。',
  CASE_NAME_EMPTY: '請輸入專題名稱。',
  CASE_NAME_DUPLICATE: '已經有同名的專題了。換一個名稱，或直接開啟既有的那一個。',
  CASE_FOLDER_EXISTS:
    '資料根裡已經有一個同名的資料夾，但裡面沒有專題 —— Cyclosa 不會往一個不是它建的資料夾裡寫東西。換一個名稱；或者到「設定 → 資料位置」看資料根在哪，用檔案總管打開 cases 底下那個資料夾，確定不需要之後自己刪掉或搬走。',
  CASE_ARCHIVED: '這個專題已封存，不能改動。要繼續的話先重新開啟它。',
  CASE_RENAME_BLOCKED:
    '資料夾正被使用中，改不了名。先讓執行中的作業跑完，或關掉開著那個資料夾的視窗，再試一次。',
  CASE_NAME_MISMATCH: '打進去的名稱跟這個專題的名稱不一樣，所以沒有刪。請逐字打對再試一次。',
  CASE_STATUS_INVALID:
    '這個專題現在的狀態做不了這個動作。最常見的是還有作業在跑 —— 先到作業紀錄把它跑完或取消，再試一次。',
  CASE_DELETE_BLOCKED:
    '資料夾正被使用中，刪不掉 —— 這個專題完整留著，沒有被刪掉一半。先讓執行中的作業跑完，或關掉開著那個資料夾的視窗，再試一次。',
  CASE_SCHEMA_TOO_NEW: '這個專題被較新版本的 Cyclosa 寫過。請先升級 —— 用舊版繼續開會寫壞資料。',
  CASE_SCHEMA_MIGRATE_FAILED: '資料庫升級失敗，已經回復到升級前的狀態。請把下面的識別碼交出來。',
  CASE_UNEXPECTED: '專題操作出了預期外的問題。請把下面的識別碼交出來。',

  // ── 檔案系統與資料根 ──────────────────────────────────
  IO_POINTER_MISSING: '還沒有設定資料要放哪裡。請選一個資料夾，之後的專題都會建在那底下。',
  IO_POINTER_MALFORMED: '記錄資料位置的檔案內容不正確。可以刪掉它重新選一次，或手動修好。',
  IO_DATA_ROOT_MISSING:
    '設定裡記的資料夾現在找不到。如果它在外接磁碟上，接回來再試一次；或重新選一個位置。',
  IO_DATA_ROOT_NOT_WRITABLE: '那個資料夾存在，但寫不進去。檢查它的權限，或換一個位置。',
  IO_DATA_ROOT_BUSY: '還有作業在跑，現在不能搬資料。等它跑完或先取消它，再試一次。',
  IO_DATA_ROOT_TARGET_INVALID:
    '不能搬到那個位置：它可能就是現在的位置、在現在這個資料夾底下，或者那裡已經有別的東西了。請換一個空的資料夾。',
  IO_DATA_ROOT_MOVE_BLOCKED:
    '資料搬不過去 —— 原本的資料完整留在原地，設定也沒有改。先讓執行中的作業跑完，或關掉開著那個資料夾的視窗，再試一次。',
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
    '對方限流了。已經照它說的等過、再試過，還是不行 —— 這個網域這一輪先不碰，其他網域照常。過一段時間再重跑這幾項。',
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
  PARSE_EMPTY_CONTENT: '抽不到正文。可以按閱讀器上的「看原始快照」確認那一頁本來就有沒有內容。',
  PARSE_JS_ONLY:
    '這一頁的內容要靠瀏覽器執行程式才會出現，靜態抓不到。目前不會交出一份空正文假裝它本來就沒東西。',
  PARSE_LOW_CONFIDENCE:
    '這一份的正文抽取信心較低，可能夾雜導覽或廣告。引用之前建議對一下原始快照。',
  PARSE_PDF_NO_TEXT_LAYER:
    '這份 PDF 沒有文字層（多半是掃描的），所以只能框選區域做註記，不能選文字。',
  PARSE_PDF_ENCRYPTED: '這份 PDF 有密碼或限制擷取。請自己解除之後再匯入。',
  PARSE_IMAGE_UNSUPPORTED: '這個圖片格式解不開。轉成 PNG、JPEG 或 WebP 再匯入。',
  PARSE_ENCODING: '這一份的文字編碼判不出來，正文可能有亂碼。可以按閱讀器上的「看原始快照」對照。',
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
  PROVIDER_QUOTE_NOT_FOUND:
    '模型給的引文在原文裡找不到，那幾條關聯沒有寫進去。一個指不到原文的出處比沒有出處更糟，所以工具寧可少一條。',
  PROVIDER_SANDBOX_VIOLATION:
    '偵測到模型在自己的工作目錄裡留下抓取產物，作業已經停下來。所有抓取都必須走同一條擷取管線。請把下面的識別碼交出來。',
  PROVIDER_EMBED_MODEL_MISMATCH:
    '要比對的向量是另一個嵌入模型產生的，所以停下來了。請換回原本的模型，或重新計算這個專題的向量 —— 硬比會得到一個看起來正常的錯答案。',
  PROVIDER_AUTH_REJECTED:
    '這個端點拒絕了金鑰。到設定頁看那個環境變數有沒有設、值對不對 —— 它不是連不上，它回了話但不讓你進。',
  PROVIDER_RATE_LIMITED:
    '這個端點說請求太多了。已經照它說的等過、再試了兩次還是一樣，作業停下來了。等一下再跑一次。',
  PROVIDER_JSON_UNSUPPORTED:
    '這個模型在這個端點上連「回一份 JSON」都不保證，所以需要結構化輸出的任務跑不了。請換一個模型或端點 —— 常見的原因是選到了不能對話的模型。',
  PROVIDER_OUTPUT_SCHEMA_MISMATCH:
    '模型回了 JSON，但形狀不對，這一項擋下來了，其餘照常。這個端點不保證格式，所以由工具檢查 —— 形狀不對的一律不收。',
  PROVIDER_UNEXPECTED: '模型呼叫出了預期外的問題。請把下面的識別碼交出來。',

  // ── 圖與裁決 ──────────────────────────────────────────
  RUN_NOT_FOUND: '找不到這次作業。它可能屬於另一個專題。',
  RUN_STILL_ACTIVE: '這次作業還在跑，沒辦法復原。先按取消，或等它跑完再試。',
  RUN_UNEXPECTED: '處理這次作業時出了預期外的問題。請把下面的識別碼交出來。',
  GRAPH_EVIDENCE_REQUIRED:
    '這條關聯沒有任何引文，不能標成已確認。請先補一筆出處，或改成自己手動建立一條。',
  GRAPH_HUMAN_ROW_IMMUTABLE:
    '有東西試圖修改你手動建立的關聯，已經擋下來了。請把下面的識別碼交出來。',
  GRAPH_TOMBSTONED:
    '這條關聯你先前否決過，所以不會再放進待查證。若之後出現新的出處，它會帶著「曾被否決」的標記重新出現。',
  GRAPH_TRANSITION_INVALID: '這個狀態變更不被允許。請把下面的識別碼交出來。',
  /**
   * **這一句要解釋「為什麼不給裁決」，不是只說不行。**
   * 使用者看到一條相似度線覺得不對而想否決它，是完全合理的念頭 ——
   * 錯的是那個念頭沒有地方去，而不是那個念頭本身。所以這句話給出去處。
   */
  GRAPH_LAYER_NOT_ADJUDICABLE:
    '共同提及、相似度、轉載這三種是算出來的結果，不是需要你判斷的主張，所以它們不能被確認或否決 —— 下次重算會把判斷蓋掉。要記錄一個判斷，請在這兩個節點之間手動建立一條具名關係。',
  GRAPH_NODE_NOT_FOUND: '找不到這個節點，它可能已經被刪掉了。回專題清單重新進來。',
  GRAPH_EDGE_NOT_FOUND:
    '找不到這條關聯。它可能已經被刪掉了，或者它是投影出來的線 —— 那種線不是資料庫裡的一列，沒有東西可以裁決。',
  GRAPH_EDGE_EXISTS: '這兩個節點之間已經有一條同樣型別的關聯了。請去改既有的那一條，不要建第二條。',
  GRAPH_AUDIT_APPEND_ONLY:
    '有東西試圖修改裁決紀錄，已經擋下來了。那份紀錄只增不刪。請把下面的識別碼交出來。',
  GRAPH_REL_EMPTY: '請寫下這是什麼關係（例如「收購」「任職於」）。沒有名字的關係日後也篩不出來。',
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
    pickHint: '點一列選取，再對它操作。點第二下直接開關聯圖。',
    picked: '選取：{name}',
    clearPick: '取消選取',
    openGraph: '關聯圖',
    rename: '改名',
    renameSave: '存檔',
    renameCancel: '取消',
    /** 資料夾會跟著改，而這件事使用者按下去之前就要知道。 */
    renameHint:
      '資料夾名稱會跟著改。已經匯出的證據包留在原本的資料夾裡 —— 那份檔案裡寫的是舊名字。',
    renamePlaceholder: '新的專題名稱',
    unreadAll: '全部標成未讀',
    /**
     * **這句話要說三件事**：數字、回不去、以及那個副作用。
     *
     * 第三件不是恐嚇：`domain/run/undo.ts` 把「你讀過」當成「人動過這一份」
     * 的訊號之一，而復原一次作業時人動過的會被留下來。
     * 清掉已讀等於部分解除那層保護，而使用者按下去之前有權知道。
     */
    unreadConfirm:
      '「{name}」現在有 {n} 份標成已讀，要全部標回未讀嗎？\n\n哪幾份讀過是你累積出來的資訊，清掉之後回不來。\n\n抓回來的內容、你的判定（已排除、已確認）都不會被動到。但要注意：復原一次作業時，「你讀過的」是它用來決定留下哪些資料的依據之一 —— 清掉之後，那些作業的復原會刪掉比現在更多的東西。',
    unreadDone: '已經把 {n} 份標回未讀。',
    unreadNone: '這個專題現在沒有任何一份標著已讀。',

    // ── 封存與重新開啟 ──────────────────────────────────
    archive: '封存',
    reopen: '重新開啟',
    archiveHint: '已封存的專題不能再被改動。要繼續做它就先重新開啟。',
    archiveDone: '「{name}」已封存。',
    reopenDone: '「{name}」已重新開啟，可以繼續做了。',

    // ── 刪除 ────────────────────────────────────────────
    del: '刪除',
    /**
     * **這一段是刪除對話框的主文**，而它要說出四件事：
     * 會失去什麼、佔多大、資料夾搬去哪、以及磁碟空間不會變多。
     *
     * 最後那一件最容易被漏掉，而漏掉的後果是使用者刪了一個 4 GB 的專題、
     * 去看硬碟、發現一點都沒空出來 —— 然後不知道該相信哪一句話。
     */
    delTitle: '刪除「{name}」',
    delLose: '會失去：{items} 份資料、{notes} 則筆記、{entities} 個實體、{edges} 條關聯。',
    delSize: '這個專題的資料夾佔 {size}。',
    delMoved:
      '資料夾會被搬進資料根底下的 backups\\ —— 這個程式從此不再讀它，清單上也不會再出現。要真的清掉，請自己去那裡刪掉那個資料夾。',
    delSpace: '所以按下去之後，磁碟的可用空間不會變多。',
    delTypeName: '確定的話，請把專題名稱逐字打一次：',
    delConfirm: '刪除這個專題',
    delCancel: '不要刪',
    delDone: '「{name}」已經刪掉了。資料夾搬到 {to}。',
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

  /**
   * 取消是誰按的。**使用者自己按的那一種沒有句子** —— 他知道自己按了什麼。
   *
   * 兩句都要說出「已經寫進去的東西還在」，因為「取消」與「白做工」
   * 在使用者腦裡很容易是同一件事，而在這個工具裡不是（ADR-0023）。
   *
   * **`stale` 不可以說「沒有正常關閉」。** 掃描能知道的只有
   * 「上一次結束時它還沒跑完」——**分不出**那次結束是按了結束鍵
   * （而它沒趕上收尾）還是被強制結束的。2026-09-10 實測就是前者：
   * 正常按結束、作業卡在一次抓取的節流裡沒收尾，於是被掃成 `stale`。
   * 寫成「沒有正常關閉」就是**把一個「不知道」講成一個確定的指控**。
   */
  runEndedReason: {
    shutdown: '這次作業是在關閉 Cyclosa 時一起停下來的。已經寫進去的內容都還在。',
    stale:
      '上一次結束的時候，這次作業還沒跑完，所以停在半路。已經寫進去的內容都還在，沒做完的那幾項標成已取消。',
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
    noTextLayer: '這份 PDF 沒有文字層，只能框選區域。不是工具壞了。',
    lowConfidenceTitle: '這份正文可能抽壞了',
  },

  /** 筆記與點註。 */
  notes: {
    panelTitle: '這一份上的點註',
    empty: '這一份還沒有點註。在正文裡選一段文字，或在圖片上框一塊。',
    emptyImage: '在圖片上按住拖曳，框出要註記的那一塊。',
    hint: '選一段文字就會出現註記框。',
    selected: '選到的是：',
    bodyLabel: '你的註記',
    bodyPlaceholder: '這一段為什麼重要？寫下來，它會變成圖上的一個節點。',
    save: '存成點註',
    cancel: '取消',
    edit: '改內容',
    remove: '刪掉',
    /** 刪之前要說出順便拿掉幾條線 —— 那是按下去才發現就太遲的事。 */
    confirmDelete: '刪掉這一則點註？圖上連著它的 {n} 條關聯會一起消失。',
    confirmDeleteNoEdge: '刪掉這一則點註？',
    locate: '在正文裡找到它',
    anchorExact: '對得上',
    anchorShifted: '位置移動過',
    anchorShiftedWhy: '原文重抽之後這一段換了位置，錨點跟著它走了。',
    anchorMissing: '找不到原文位置',
    anchorMissingWhy: '註記內容還在。原文可能重抽過，或那一份的快照換了。',
    onPage: '第 {n} 頁',
    rect: '圖上的一塊區域',
    count: '共 {n} 則點註',
    unresolved: '{n} 則對不上原文',
    tooShort: '選得太短了。至少要兩個字。',
    imageDrag: '框選中…',
  },

  /** `derived/` 整批重算。 */
  rebuild: {
    button: '重算全部正文',
    /** 這顆按鈕會跑一段時間而且會改畫面上的東西，所以按之前要說清楚它做什麼。 */
    confirm:
      '把這個專題的正文全部刪掉、從原始快照重新抽一次？\n\n抓回來的快照不會被動到，你的判定（已排除、已確認）也不會。',
    running: '正在重算…',
    done: '重算完成：{items} 份資料重抽了 {reextracted} 份。',
    failed: '其中 {n} 份這一次抽不出正文。',
    missing: '其中 {n} 份的快照不見了。',
    notesOk: '{n} 則點註全部對得上原文。',
    notesShifted: '{n} 則的位置移動過（錨點已經跟著走）。',
    notesUnresolved: '{n} 則對不上原文 —— 內容都留著。',
    noNotes: '這個專題還沒有點註。',
  },

  /** 來源網站清單。 */
  sources: {
    title: '來源網站',
    intro:
      '這一頁決定 agent 優先往哪裡找。它不擋任何東西 —— 讀不到的來源仍然會出現在清單上，只是不優先。',
    /** 判斷的依據要說出來，因為「探測」與「你自己抓過」的可信度差很多。 */
    basisHistory: '依你抓過的 {n} 次',
    basisProbe: '依一次檢查',
    basisNone: '還沒有依據',
    access: {
      open: '讀得到',
      login: '要登入或訂閱',
      throttled: '對方限流中',
      unreachable: '連不到',
      disallowed: 'robots 不准',
      'js-only': '靜態抓不到',
      unknown: '不知道',
    },
    expected: {
      open: '一般開放',
      login: '一般要訂閱',
      mixed: '看單篇',
    },
    kind: { api: 'API', site: '網站' },
    category: {
      'scholarly-api': '書目 API',
      preprint: '預印本',
      'open-repository': '開放全文庫',
      publisher: '出版社',
      official: '官方',
      reference: '參考',
    },
    columns: {
      site: '來源',
      status: '現在讀不讀得到',
      attempts: '抓過',
      checked: '檢查時間',
      actions: '',
    },
    check: '檢查全部',
    checkOne: '檢查',
    checking: '檢查中…',
    /** 檢查要說清楚它會送出真的請求，因為這個工具對外的行為是有承諾的。 */
    checkNote:
      '檢查會對有探針的來源各送一個請求，走的是同一條擷取管線（遵守 robots、同網域間隔、收到 429／503 退避重試）。',
    noProbe: '沒有探針',
    noProbeWhy:
      '出版社的首頁一律回 200 而文章回 403，所以探首頁沒有意義。這一列的判斷完全來自你自己抓過的結果。',
    builtIn: '內建',
    disable: '關掉',
    enable: '打開',
    disabled: '已關掉',
    addTitle: '自己加一個',
    addHost: '網域（例如 example.org）',
    addName: '顯示名稱',
    addProbe: '探針網址（選填）',
    add: '加進清單',
    empty: '清單是空的。',
    lastCheckedNever: '還沒檢查過',
  },

  /** 實體對齊。 */
  entities: {
    mergeTitle: '看起來是同一個',
    /** 這個數字要說出後果，不然它只是一個待辦。 */
    mergeWhy:
      '同一個東西的兩種寫法會變成兩個節點，而投影門檻是「被 3 份以上提到才畫」—— 拆成三種叫法的實體可能一個都不會出現在圖上。',
    mergeNone: '沒有看起來重複的實體。',
    reason: {
      'same-key': '正規化之後完全一樣',
      alias: '別名對得上',
      parenthetical: '括號裡的寫法對得上',
    },
    keep: '留下',
    mergeInto: '併進去',
    mentions: '被 {n} 份提到',
    aliases: '別名：{list}',
    merge: '合併',
    merged: '已合併 {moved} 條關聯。',
    duplicates: '其中 {n} 條變成了平行線 —— 兩條同樣的關係並排。可以否決其中一條。',
    undo: '取消合併',
    undone: '已還原 {n} 條關聯。',
    /** 合併要人按，而且理由要寫在按鈕旁邊。 */
    confirmMerge:
      '把「{merge}」併進「{keep}」？\n\n併完之後圖上顯示的是「{keep}」，而「{merge}」會變成它的別名。這個動作取消得掉。',
  },

  /**
   * 證據包匯出。
   *
   * 這一組字裡最重要的是 `missingWhy` —— 一份把回溯不到的引文
   * 靜靜省略掉的證據包，會比它實際上更乾淨，而使用者不會知道。
   */
  exportPack: {
    title: '證據包',
    open: '匯出證據包',
    /** 按下去會在磁碟上產生檔案，所以按鈕旁邊先說它會產生什麼。 */
    intro: '把畫面上這一塊匯出成三個檔：一份關聯與引文、一份來源清單、一份每條引文一列的 JSONL。',
    scope: '範圍：焦點往外 {hops} 跳，畫面上 {nodes} 個節點',
    scopeNote: '匯出的就是你現在看到的這一塊 —— 換跳數或篩選會換掉範圍。',
    run: '匯出',
    busy: '匯出中…',
    done: '匯出完成',
    folder: '位置',
    copyPath: '複製路徑',
    copied: '已複製',
    counts: '{nodes} 個節點 · {edges} 條關聯 · {quotes} 條引文',
    quoteBreakdown: '已核對 {verified} · 位置已移動 {shifted} · 回溯不到 {missing}',
    sources: '來源 {sources} 份 · 點註 {notes} 則',
    /** 位置移動不是錯誤，而且不說一聲的話它看起來像。 */
    shiftedWhy:
      '位置移動的那幾條，引文一字不差，只是重算過的正文把它挪到別的位置了。檔案裡兩組數字都寫了。',
    missingWhy:
      '回溯不到的那幾條照樣在檔案裡，而且標明了。省略它們會讓這份證據包看起來比實際上乾淨。',
    projected:
      '另外 {n} 條投影出來的共同提及線沒有匯出 —— 它們不是資料庫裡的關聯，每次打開都重算，沒有出處可以附。',
    noEdges: '這一塊裡沒有關聯。匯出的會是一份來源清單。',
  },

  /**
   * 檢索。**三種狀態各自有一句話** —— 見 `search-service.ts`：
   * 合成一句的話，「正文被清掉了」會被說成「這一筆是誤中」。
   */
  search: {
    open: '搜尋',
    title: '在這個專題裡搜尋',
    placeholder: '兩個字就查得到',
    run: '搜尋',
    busy: '搜尋中…',
    summary: '{n} 筆 · {ms} 毫秒',
    empty: '沒有找到。換個說法，或先確認那份東西已經匯入了。',
    entity: '實體',
    kinds: {
      web: '網頁',
      pdf: 'PDF',
      image: '圖片',
      text: '純文字',
      paper: '論文',
      note: '筆記',
    },
    /** 三種模式。**每次搜尋都可能想換**，所以是三顆並排的按鈕 */
    modes: {
      text: '全文',
      semantic: '語意',
      hybrid: '兩者',
    },
    modeWhat: {
      text: '找正文裡真的有這串字的。中文兩個字就查得到。',
      semantic: '找講同一件事、但用字不同的。需要設定嵌入模型。',
      hybrid: '兩條路一起跑，輪流取名次 —— 分數不混在一起算。',
    },
    /** 中文的索引是兩字一組，所以「台積電」會誤中「來台積極…累積電力」。 */
    miss: '可能是誤中：正文裡沒有這串字',
    /** **語意命中不是誤中。** 正文裡沒有那串字是它的用途，不是它的缺陷 */
    semantic: '用字不同，但這一段講的是同一件事',
    /** 向量是逐專題的，所以這顆按鈕在搜尋面板而不是設定頁 */
    build: '建立語意索引',
    building: '建立中…',
    buildLeft: '還有 {n} 份沒算，目前 {rows} 段。再按一次會接下去。',
    buildDone: '{owners} 份資料、{rows} 段都算好了。',
    embedNoModel: '還沒設定嵌入模型 —— 到設定頁選一個，這裡才算得出向量。',
    noText: '正文不在，這一筆沒驗過',
    incomplete: '有作業還在跑，這次的結果可能不完整。',
    embedUnavailable: '這次沒有跑語意檢索（沒設定嵌入模型，或者連不上），只有全文的結果。',
    openReader: '在閱讀器開啟',
  },

  /** 結束 Cyclosa（頂列右邊）。 */
  shutdown: {
    open: '結束 Cyclosa',
    confirmIdle:
      '要結束 Cyclosa 嗎？\n\n伺服器會關掉，這個分頁就打不開了。資料都已經存好，下次啟動接得回來。',
    /** 有作業在跑的時候，確認要說出那個數字。 */
    confirmBusy:
      '有 {n} 個作業正在跑。結束的話它們會中斷。\n\n已經寫進去的東西會留著（取消不回滾），但沒做完的那幾項會停在原地。要結束嗎？',
    done: 'Cyclosa 已經關掉了。這個分頁沒有自己關掉的話，是因為瀏覽器只讓網頁關掉自己開的分頁 —— 手動關掉它就可以了。',
    failed: '關不掉。先重新整理看看它是不是其實已經停了；還在的話，用工作管理員結束 node.exe。',
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
    /** 數字由畫面從 `/api/system/fetch-policy` 填進來 —— 這裡不寫死。 */
    throttleInterval: '同網域間隔 {seconds} 秒',
    throttleBackoff: '收到 429／503 照 Retry-After 退避，最多再試 {n} 次',
    throttleRobots: '遵守 robots.txt',
    throttleNow: '正在等 {host}（{ms} 毫秒）',
  },

  runControl: {
    pause: '暫停',
    resume: '繼續',
    paused: '暫停中',
    /** 暫停與取消的差別要寫在按鈕旁邊，不然兩顆看起來一樣。 */
    pauseHint: '正在做的那一項會做完，然後停在下一項之前。隨時可以繼續。',
    undo: '復原這次作業',
    undoConfirm:
      '把這次作業寫進去的東西刪掉？\n\n抓回來的原始快照不會被動到，你裁決過的關聯、讀過或標過點註的資料也不會。這個動作沒辦法取消。',
    undone: '已刪掉 {items} 份資料、{edges} 條關聯。',
    undoneEntities: '另外清掉 {n} 個因此沒有任何關聯的實體。',
    /** 留下來的東西要解釋，不然使用者會問「為什麼圖上還有」。 */
    undoKept: '留下 {items} 份資料與 {edges} 條關聯 —— 你動過它們。',
    undoKeptEvidence: '其中 {n} 份是因為有一條留下來的關聯靠它當出處。',
    undoNothing: '這次作業沒有東西可以刪了。',
  },

  graph: {
    tab: '關聯圖',
    empty: '這個專題還沒有任何資料。到「作業紀錄」貼一個網址或拖一個檔案進來。',
    /**
     * **這一句一定要在。** v0.3.0 的圖畫得出節點但畫不出關聯，
     * 因為關聯要到下一階段才會產生 —— 而一張只有點沒有線的圖
     * 看起來就像壞掉了。**說出來就不是壞掉，是還沒到。**
     */
    noEdges:
      '這個專題還沒有任何關聯，所以圖上只有資料節點。關聯要到「關聯與出處」與「LLM 擴展」才會產生。',
    loading: '正在算這一屏…',

    toolbar: {
      hops: '焦點跳數',
      hopUnit: '{n} 跳',
      flat: '2D 平面',
      solid: '3D',
      relayout: '重新佈局',
      counts: '畫面上 {visible}／專題共 {total} 個節點',
      overBudget: '超過 {budget} 個節點，這一格沒有被驗收過',
      /** 走訪在硬上限就停了，所以那個數字是下界。**不要讓下界看起來像一個數。** */
      capped: '超過 {limit} 個節點就停止計算了 —— 這一格按下去會是「範圍太大」。實際數字更多',
      focusOn: '以此為焦點',
      openInReader: '在閱讀器開啟',
    },

    legend: {
      title: '圖例與篩選',
      showDerived: '把轉載的線畫出來',
      showRejected: '顯示已否決的',
      projection: '實體提到幾篇才成為節點',
      projectionHint: '低於這個數字的實體會被攤平成一條線，只被一篇提到的完全不畫。',
      minConfidence: '可信度下限',
      tierAny: '不限',
      hint: '明暗只表示遠近，不表示程度。',
    },

    /**
     * **顏色與記號的說明，一份。**
     *
     * `short` 給圖上那一欄（232px，看著圖即時對照），
     * `long` 給設定頁的「狀態說明」分頁（一次看完）。
     * 清單本身在 `components/graph/legend-items.ts`，
     * 而 `tests/guards/legend-coverage.test.ts` 釘住三邊對得上。
     *
     * 兩個 map 刻意宣告成 `Record<string, …>`：清單是資料驅動的，
     * 而**「少一個 key」這件事由測試抓，不是由型別抓** ——
     * 型別只擋得住寫死的存取，擋不住一個從陣列裡拿出來的 key。
     */
    guide: {
      title: '狀態說明',
      what: '圖上每一個顏色、每一種線、每一個記號的意思。看完這一頁就不用在圖上猜。',
      sections: {
        nodes: '節點',
        rings: '環與強調',
        layers: '關聯的四層',
        status: '查證狀態',
        projection: '實體投影的三段',
        panel: '面板上的顏色',
        rules: '四條通則',
      } as Readonly<Record<string, string>>,
      items: {
        nodeItem: {
          short: '資料（抓回來的）',
          long: '從網路或檔案抓回來的一份東西：網頁、PDF、圖片、Markdown、論文。方形、填滿冷藍，外面一圈深色描邊。',
        },
        nodeNote: {
          short: '筆記（自己寫的）',
          long: '你自己寫的點註。方形、填滿暖洋紅。它與資料藍的差別在色盲下也分得開，這是量過的。',
        },
        nodeEntity: {
          short: '實體（空心）',
          long: '從正文裡抽出來的人、組織、地點、作品。空心線框、不描邊 —— 它靠形狀跟前兩種分開，不靠第三個顏色。那個顏色不存在：掃過整個色相環之後，能同時通過藍與洋紅的第三色全部落在琥珀到綠之間，而那一段保留給狀態。',
        },
        nodeExcluded: {
          short: '已排除（打叉）',
          long: '你把它排除掉的資料。中間一個叉，預設隱藏。只由人設定 —— 機器不會自己排除任何東西。',
        },
        ringSelected: {
          short: '選取（青色外環）',
          long: '你現在點的那一個。「剛讀過」不是一個獨立狀態，它就是選取。',
        },
        ringFocus: {
          short: '焦點（紫色環）',
          long: '這一次子圖的出發點，一圈傾斜的紫色緞帶。它永遠停在畫面正中央 —— 轉動中心就是焦點，不是畫面中心點。',
        },
        readWeight: {
          short: '已讀＝標籤變細',
          long: '未讀的節點標籤是粗體，讀過之後變回一般字重。它在圖上不是一個環 —— 那個環量過幾何之後拿掉了，因為它的半徑跟方塊的側影撞在一起。實體沒有「已讀」這件事，一律一般字重。',
        },
        neighbour: {
          short: '一跳鄰域只提亮',
          long: '離焦點一跳的節點會亮一點，其餘的暗一點，沒有第二個框。休息狀態固定帶一層霧化底。',
        },
        layerNamed: {
          short: '具名關係（漸細）',
          long: '要引文、要你裁決的那一種：「收購」「任職於」。漸細代表有方向 —— 從粗的那一端指向細的那一端。四層裡只有這一層會被裁決。',
        },
        layerComention: {
          short: '共同提及（線中方塊）',
          long: '兩份資料提到同一個實體，而那個實體還沒有多到值得自己站成一個節點。線中間那個空心方塊就是那個實體本人，不是裝飾。',
        },
        layerComentionOpen: {
          short: '共同提及（實體已展開）',
          long: '同一種關係，但那個實體已經展開成節點了，所以線上不需要再放一個方塊，畫成等寬。等寬代表沒有方向。',
        },
        layerSimilarity: {
          short: '相似度（點線）',
          long: '兩份內容像。這是算出來的結果，不是誰提出的主張 —— 所以它不能被確認或否決，下次重算會把判斷蓋掉。',
        },
        layerDerived: {
          short: '衍生（摺進來源）',
          long: '轉載、翻譯這一類機器可驗的關係。預設摺進來源節點裡，左欄那個開關可以把它畫出來。它不進裁決。它存在的用途是算「出處 5 筆，但獨立來源只有 2 個」。',
        },
        statusPending: {
          short: '待查證（琥珀虛線）',
          long: '機器提出來、還沒有人看過的主張。虛線加琥珀是兩重編碼 —— 只靠顏色的話，它在色盲下會跟已確認撞在一起。',
        },
        statusConfirmed: {
          short: '已確認（灰實線）',
          long: '你看過出處、同意了。灰色是刻意的：已確認是常態，而常態不該是畫面上最搶眼的東西。',
        },
        statusRejected: {
          short: '已否決（打叉）',
          long: '你否決過的主張，預設隱藏。它不用顏色用形狀 —— 那一段的顏色預算滿了，而一個打叉在任何色覺下都是一個打叉。否決是墓碑：機器不會再提同一條，除非它帶著先前沒有的出處回來，那時它會標著「曾被否決」。',
        },
        projectionOne: {
          short: '被 1 份提到：不畫',
          long: '它只是那一份資料的一個屬性。攤平出來是 0 條線 —— 畫成線跟不畫在畫面上一模一樣，所以這個門檻沒有做成旋鈕。',
        },
        projectionTwo: {
          short: '被 2 份提到：投影成線',
          long: '兩份資料之間畫一條共同提及線，那個實體變成線中間的方塊。',
        },
        projectionThree: {
          short: '被 3 份以上提到：展開成節點',
          long: '它自己站成一個空心節點。門檻可以在左欄調，而且不進資料庫 —— 它是一個看法，不是一筆資料。例外：帶著具名關係的實體一律畫成節點。',
        },
        panelSuccess: { short: '綠：確認', long: '只出現在面板與文字上，不上關聯圖。' },
        panelDanger: {
          short: '紅：壞掉的東西，以及回不去的動作',
          long: '紅色在關聯圖上永遠不會出現。它留給兩種東西：失敗，以及按下去就回不來的動作（刪除專題）。它不留給「你不同意的主張」—— 否決一條關聯不是一個錯誤。',
        },
        panelAction: { short: '藍：主要動作', long: '按鈕與連結。同樣不上關聯圖。' },
        ruleDepth: {
          short: '明暗只表示遠近',
          long: '一個節點比較暗，代表它離你比較遠，不代表它比較不重要或比較不可信。',
        },
        ruleDirection: {
          short: '漸細＝有方向',
          long: '線從粗漸細代表它有方向；等寬代表沒有方向。這是四層裡唯一靠形狀傳達方向的地方。',
        },
        ruleWidth: {
          short: '粗細讀不出數字',
          long: '線粗一點代表可信度高一點，但你不該從寬度反推出一個分數 —— 人對寬度的判讀誤差比那個分數的解析度還大。要看數字就點那條線。',
        },
        ruleSecondEncoding: {
          short: '每個狀態都有第二重編碼',
          long: '顏色之外一定還有一樣東西：形狀、線型、圖示或文字。所以這張圖在色盲、在灰階列印、在半夜調暗的螢幕上都讀得出來。',
        },
      } as Readonly<Record<string, { short: string; long: string }>>,
    },

    selection: {
      title: '選取的',
      none: '在圖上點一個節點，這裡會顯示它的細節。',
      kind: '型別',
      mentions: '被 {n} 份文件提到',
      folded: '摺了 {n} 個轉載',
      read: '已讀',
      unread: '未讀',
      language: '語言',
      excerpt: '摘要',
      edgesHere: '它的關聯（畫面上 {n} 條）',
      edgeTitle: '關聯',
      between: '兩端',
      tier: '可信度',
      facts: '構成事實',
      evidence: '出處 {n} 筆',
      independent: '{n} 個獨立來源',
      independentWarning: '出處筆數不等於獨立來源數 —— 轉載算同一個來源。',
      hasQuote: '有直接引文',
      noQuote: '沒有直接引文',
      previouslyRejected: '曾被否決',
      synthetic: '這條線是投影出來的，不是資料庫裡的一列。',
      calibrationInsufficient: '樣本不足，不顯示比例',
      openEdge: '看這條關聯',
    },

    /** 裁決。 */
    adjudication: {
      title: '這條關聯',
      back: '回到節點',
      loading: '正在讀這一條…',
      origin: '來源',
      originHuman: '你手動建立的',
      originMachine: '機器抽取的',
      createdAt: '建立於',

      /**
       * **動詞，不是名詞。** 按鈕上寫「確認」而不是「已確認」——
       * 前者說的是按下去會發生什麼，後者說的是現在的狀態。
       */
      confirm: '確認',
      reject: '否決',
      withdraw: '撤回確認',
      reclassify: '改判',
      restore: '復原',

      /** 每個動作按下去之前先說它會做什麼 —— 六條轉移沒有一條是明顯的。 */
      hint: {
        confirm: '這條關聯成立，把它當成已知的事實用下去。',
        reject: '這條關聯不成立。它會被隱藏，而且機器不會再提第二次。',
        withdraw: '收回先前的確認，讓它回到待查證。出處與歷史都留著。',
        reclassify: '改掉先前的判斷。舊的判斷會留在歷史裡，不會被蓋掉。',
        restore: '把它從已否決放回待查證，重新考慮。',
      },

      /** **否決可以復原。紅色留給真的壞掉的東西**（ui-workflows）。 */
      rejectedNotice: '已否決的關聯預設不會畫在圖上。它沒有被刪掉 —— 隨時可以復原。',
      needsEvidence: '這條是機器抽出來的，而且一筆引文都沒有，所以確認不了。',
      notAdjudicable:
        '這是算出來的結果，不是需要你判斷的主張，所以沒有確認與否決 —— 下次重算會把判斷蓋掉。',

      evidence: '出處與引文',
      noEvidence: '沒有引文。',
      humanNoEvidence: '這條是你自己連的，出處就是你。',
      fromItem: '出自',
      charRange: '第 {start}–{end} 字',

      history: '裁決歷史',
      noHistory: '還沒有人裁決過這一條。',
      byHuman: '你',
      byMachine: '機器',
      /** **稽核紀錄裡唯一一種機器動作** —— 它要解釋得夠清楚 */
      revived: '機器帶著新的出處把它放回待查證',
      action: {
        confirm: '確認',
        reject: '否決',
        withdraw: '撤回確認',
        reclassify: '改判',
        restore: '復原',
      },

      calibration: '同一段的關聯，你過去確認了 {confirmed}%、否決 {rejected}%（採樣 {n} 條）',
      calibrationShort: '你的裁決：確認 {confirmed}%／否決 {rejected}%（{n} 條）',
    },

    /** 裁決佇列。**沒有獨立畫面** —— 它是關聯圖上的一條 */
    queue: {
      pending: '待查證 {n} 條',
      none: '沒有待查證的關聯',
      next: '跳到下一條',
      onlyNamed: '只有具名關係需要你判斷。',
    },

    /** 手動連線。 */
    connect: {
      start: '建立關聯',
      /** **進行中的模式一定要說出來**，否則下一次點擊會做出使用者沒預期的事 */
      picking: '正在拉一條線：請在圖上點另一個節點當終點。',
      from: '起點',
      to: '終點',
      rel: '這是什麼關係',
      relPlaceholder: '例如：收購、任職於、引用',
      layer: '關聯種類',
      layerNamed: '具名關係（你的主張，需要判斷）',
      layerDerived: '轉載（同一則的另一個版本）',
      create: '建立',
      cancel: '取消',
      /**
       * **未來式。** 這一句顯示在「建立」按下去**之前**，
       * 而第一版寫成「已建立，而且…」—— 讀起來像已經發生了，
       * 於是使用者會以為不必再按那個按鈕。
       */
      createdNotice: '建立之後它就是「已確認」，不需要引文 —— 出處就是你。',
    },

    tier: {
      weak: '弱',
      medium: '中',
      strong: '強',
    },

    layer: {
      derived: '衍生',
      named: '具名關係',
      comention: '共同提及',
      similarity: '相似度',
    },

    edgeStatus: {
      pending: '待查證',
      confirmed: '已確認',
      rejected: '已否決',
    },

    entityType: {
      person: '人物',
      org: '組織',
      place: '地點',
      event: '事件',
      work: '作品',
      concept: '概念',
    },

    itemKind: {
      web: '網頁',
      pdf: 'PDF',
      image: '圖片',
      text: '純文字',
      paper: '論文',
      note: '筆記',
    },
  },

  /**
   * 擴展。
   *
   * **這一區的每一句都在說「這不是黑箱」** ——
   * 工具打算怎麼找、找到了什麼、你勾了哪幾條、花了幾次呼叫。
   */
  expand: {
    open: '擴展',
    title: '擴展這個專題',
    topicLabel: '從哪個主題出發',
    topicPlaceholder: '一個主題、一個人、一個事件',
    submit: '產生切入角度',
    working: '正在想切入角度…',
    /** **這一句一定要在。** 第一階段結束時什麼都還沒抓，而畫面必須說出來 */
    notYet: '還沒有開始抓任何東西。勾選要展開的角度之後才會開始。',
    anglesTitle: '擴展的切入角度',
    /** 視角是從既有內容歸納出來的（STORM），所以要說出「依據幾份」 */
    seededFrom: '這幾條是從你已經有的 {n} 份歸納出來的。',
    seededFromNothing: '這個專題還是空的，所以這幾條只從主題本身來 —— 沒有既有內容可以依據。',
    seedsLabel: '依據',
    noSeeds: '沒有對應到既有的哪一份',
    start: '展開勾選的 {n} 條',
    pickAtLeastOne: '至少要勾一條',
    tooMany: '一次最多勾 {n} 條',
    colAngle: '切入角度',
    colStance: '立場',
    colFound: '找到網址',
    colNodes: '新增節點',
    colEdges: '新增關聯',
    colNote: '備註',
    notSelected: '沒有勾選',
    /** 請求數是主要上限（ADR-0006）。**沒有記下來的請求數是假的** */
    /**
     * **擴展的「一項」是一條角度，不是一個網址。**
     *
     * 沿用匯入那一句「共 N 項」的話，畫面上會出現「共 1 項」
     * 配著下面六列網址 —— 而那六列裡有五列是失敗的。
     */
    counts: '成功 {succeeded}、失敗 {failed}，共 {total} 條角度',
    requests: '打了 {n} 次模型',
    /** **`null` 與 0 是兩件事** —— 這一句只在 provider 真的回報時出現 */
    cost: '花費 {usd} 美元',
    costLocal: '本機執行，無金額成本',
    costUnknown: '這個模型沒有回報金額',
    usedProviders: '用的是 {chat}',
    machineOnly: '機器抽出來的關聯一律進「待查證」，沒有任何一條路會自動確認。',
  },

  settings: {
    title: '設定',
    tabs: {
      models: '模型',
      sources: '來源網站',
      guide: '狀態說明',
      storage: '資料位置',
    },
    /**
     * 資料位置。**第一次啟動不問就建好了**，
     * 所以這一頁的工作是「告訴你它在哪」，其次才是「換一個地方」。
     */
    storage: {
      what: '所有專題、快照與匯出都放在這個資料夾底下。它不在程式資料夾裡，所以更新或重灌 Cyclosa 不會動到它。',
      current: '現在的位置',
      pointer: '這個位置記在',
      moveTitle: '換一個位置',
      moveWhat:
        '底下的東西會一起搬過去，搬完清單上的專題數應該跟現在一樣。目標必須是一個空的資料夾（或還不存在的路徑）。',
      movePlaceholder: 'D:\\Cyclosa\\data',
      moveSubmit: '搬過去',
      moveBusy: '搬移中，請不要關掉這個視窗⋯',
      moveDone: '已經搬到 {to}。',
      /** **搬家會把 `case.sqlite` 從一個正在寫它的行程底下抽走**，所以有作業在跑就擋。 */
      moveBusyRuns: '還有作業在跑的時候不能搬。先到作業紀錄把它跑完或取消。',

      // ── 範例專案 ──────────────────────────────────────
      sampleTitle: '範例專案',
      sampleWhat:
        '第一次啟動時會放一份範例專案，裡面是八條中華民國法律的條文原文，每一份都指得回它自己那一條的網址。刪掉之後不會自己回來 —— 要的話按這裡。',
      sampleLicence:
        '語料來自全國法規資料庫的官方開放資料（政府資料開放授權條款第 1 版）。條文原文依著作權法第 9 條本來就不是著作權的標的。',
      /** **這句話一定要說。** 那四條已確認的關聯不是誰真的裁決過的紀錄。 */
      sampleNotReal: '範例裡標成「已確認」的關聯是示範資料，不是任何人真的裁決過的紀錄。',
      sampleBuild: '重建範例專案',
      sampleBusy: '建立中⋯',
      sampleDone: '範例專案已建立：{items} 份資料、{entities} 個實體、{edges} 條關聯。',
      sampleExists: '已經有一份範例專案了。要重建的話先把它刪掉。',
    },
    /** 現在正在用哪一個 —— **要在按下去之前看得到，不是想起來的時候。** */
    activeNone: '還沒設定模型',
    activeLabel: '模型',
    version: '版本',
    versionUnknown: '問不到版本',
    purpose: '用途',
    /** 金鑰只從環境變數讀，不存進任何一個檔。 */
    apiKeyEnv: '金鑰的環境變數名稱',
    apiKeyEnvHint:
      '只填變數的名字（例如 OPENAI_API_KEY），不要填金鑰本身 —— 這個設定檔會被備份，也會在求助時被整份貼出來。留空代表不帶授權標頭（本機 Ollama 就是這樣）。',
    auth: {
      none: '不帶金鑰',
      'env-set': '偵測到這個環境變數',
      'env-missing': '找不到這個環境變數 —— 設好之後要重新啟動這個工具。',
    },
    lastUsed: '上次用於',
    /** 三個角色都列出來 —— 少列一個，使用者會以為只有兩種模型 */
    roles: {
      agent: '找來源（agent）',
      chat: '歸納與抽取（chat）',
      embed: '語意檢索（embed）',
    },
    roleWhat: {
      agent: '用搜尋找出候選網址。它不抓網頁 —— 抓取一律走同一條擷取管線。',
      chat: '從既有內容歸納切入角度，並從抓回來的正文抽出實體與關係。',
      embed: '語意檢索用的向量。匯入時就會算，查詢時把問句也變成向量來比對。',
    },
    state: {
      ready: '可以用',
      'not-configured': '還沒設定',
      unreachable: '連不上',
    },
    capabilities: '能力宣告',
    capabilityNames: {
      browse: '自己上網',
      tools: '工具呼叫',
      json_schema: '保證 JSON 結構',
      vision: '看得懂圖',
    },
    contextTokens: 'context {n} tokens',
    contextUnknown: 'context 大小不明',
    missing: '這個角色要跑的任務需要：{flags}，而目前設定的模型沒有。',
    /** 不自動降級是 ADR-0006 的決定，畫面上要說得出來 */
    noFallback: '配不上就停手，不會自動換一個能力較弱的來跑。',
    /**
     * 連線方式。本機 Ollama 留在原生協定是量出來的：
     * OpenAI 相容那條送不了「關掉思考」，同一題慢 9 倍。
     */
    transport: '連線方式',
    transportNames: {
      ollama: '本機 Ollama',
      openai: 'OpenAI 相容端點',
    },
    transportWhat: {
      ollama:
        '走 Ollama 自己的協定。這樣才能關掉模型的思考、指定 context 大小 —— 兩件事都量過會影響結果。',
      openai:
        '線上的服務，或別家本機伺服器（vLLM、LM Studio 之類）。位址照那一家的文件寫，通常以 /v1 結尾。',
    },
    chatBaseUrl: '位址',
    chatBaseUrlOpenaiPlaceholder: 'https://api.example.com/v1',
    chatModel: '模型',
    chatModelPick: '選一個本機有的模型',
    chatModelPickOnline: '選一個這個端點有的模型',
    chatModelsUnreachable: '連不上這個位址，所以列不出有哪些模型。',
    chatModelsUnreachableOnline:
      '列不出這個端點的模型。檢查位址是不是以 /v1 結尾，以及金鑰那個環境變數有沒有設。',
    /**
     * 「符合格式」由誰保證。事後檢查是一種降級，
     * 而它被允許的條件是說出來 —— 所以這一行一定要在。
     */
    jsonModeLabel: '格式保證',
    jsonMode: {
      schema: '由端點保證（json_schema）',
      object:
        '由 Cyclosa 事後檢查。這個端點只保證回一份 JSON，形狀不對的回應一律擋下來、不會寫進專題。',
      none: '這個模型在這個端點上連 JSON 都不保證，需要結構化輸出的任務（切入角度、抽取關聯）跑不了。常見的原因是選到了不能對話的模型（例如嵌入模型）—— 下面那行是端點自己說的理由。',
      unchecked:
        '還沒量過。第一次真的跑任務時會先量一次（一到兩個很小的請求），也可以按「實際打一次」現在量。',
    },
    jsonModeNative: '由協定保證（Ollama 的 format 是受限解碼）',
    jsonCheckedAt: '{date} 量的',
    /** 各任務那張表：覆寫的模型各有各的格式保證，事後檢查的那幾列要標出來 */
    taskJsonObject: '事後檢查格式',
    /** 建議值是量出來的，而畫面上要說得出「量了什麼」 */
    chatRecommend: '建議 {model}',
    chatRecommendWhy:
      '2026-09-09 拿 1955 段真實網頁量過八個本機模型：抽關聯六次全過、引文在原文裡找得到的比例 98%、平均 5 秒（第二名 17 秒），而它只有 3.4 GB。歸納角度那一題它只給四條，要六條的話改用 granite4.2:8b。',
    /**
     * 逐任務覆寫（2026-09-10）。**這一區預設是收起來的** ——
     * 大多數人只要一個模型，而多出來的兩個下拉選單會讓那件事看起來變複雜。
     */
    chatTaskTitle: '逐任務指定不同的模型',
    chatTaskWhy:
      '這個角色底下有兩件事，而量測顯示它們的最好解不是同一個模型。留白就是兩件事都用上面那一個。',
    chatTaskNames: {
      angles: '歸納切入角度',
      extract: '從正文抽實體與關係',
    },
    chatTaskWhat: {
      angles: '從專題裡已經有的內容歸納出幾條可以往下查的子問題。',
      extract: '把抓回來的正文變成實體與帶引文的關聯 —— 圖上長出什麼由這一步決定。',
    },
    /** 留白與「刻意選成同一個」是兩件事，所以選單裡要有這一項 */
    chatTaskFollow: '跟著上面的預設',
    chatTaskRecommend: '建議 {model}',
    chatTaskRecommendWhy: {
      angles:
        '同一輪量測裡它給滿六條角度（多數模型只給四條），而且角度彼此的相似度最低（0.712）—— 那一欄量的是「多視角有沒有真的多視角」。5.3 GB，跟 4b 加起來 8.7 GB，兩個可以同時常駐。',
      extract:
        '抽關聯六次全過、引文在原文裡找得到的比例 98%、平均 5 秒（第二名 17 秒），而它只有 3.4 GB。',
    },
    /** **實際會跑的那一個** —— 覆寫之後上面那一格就不再等於它 */
    chatTaskRuns: '實際會跑：{model}',
    chatTaskUnset: '還沒有模型可以跑這一件事。',

    // ── 兩個段落（2026-09-10）─────────────────────────
    //
    // 上面那一段回答「連到哪裡、有哪些模型可以用」，
    // 下面那一段回答「每一件事各自跑哪一個」。
    // **合成一段的話，找來源與嵌入會被埋在 chat 底下**，
    // 而使用者問的是一份完整清單。
    sectionModels: '可調用模型',
    sectionModelsWhat:
      '每個角色連到哪裡、目前有哪些模型可以用。本機模型的清單是問 Ollama 拿的，不是我們維護的名單 —— 名單會漂，而漂掉的名單比沒有名單更糟。',
    sectionTasks: '各任務模型',
    sectionTasksWhat:
      '這個工具會用到模型的四個地方，每一個都可以單獨挑。留白的那幾格會跟著上面那個角色的預設走。',
    taskTableHead: {
      task: '任務',
      role: '角色',
      model: '模型',
      status: '實際狀態',
    },
    taskNames: {
      'find-sources': '找候選來源',
      angles: '歸納切入角度',
      extract: '從正文抽實體與關係',
      embed: '算語意檢索的向量',
    },
    taskWhat: {
      'find-sources': '用搜尋找出候選網址。它不抓網頁 —— 抓取一律走同一條擷取管線。',
      angles: '從專題裡已經有的內容歸納出幾條可以往下查的子問題。',
      extract: '把抓回來的正文變成實體與帶引文的關聯 —— 圖上長出什麼由這一步決定。',
      embed: '把正文與問句都變成向量，讓用字不同的東西也找得到。換掉要全部重算。',
    },
    /** 留白不是「沒設定」，是「跟著角色的預設」—— 兩件事在畫面上要分得開 */
    taskFollowsDefault: '跟著這個角色的預設',
    taskOverridden: '已覆寫',

    // ── 金鑰怎麼設（2026-09-10）───────────────────────
    //
    // **讀不到的時候最常見的原因不是打錯字，是沒有重開。**
    // 環境變數是行程啟動時繼承的一份拷貝，`setx` 之後
    // 已經開著的程式讀不到後來設的值。一個只寫「沒偵測到」的畫面
    // 會讓人一直重打那個名字。
    apiKeyHowTo: '在 PowerShell 裡跑一次下面這行（只要跑一次，它寫進使用者層級的環境變數）：',
    apiKeyPlaceholder: '你的金鑰',
    apiKeyRestart:
      '跑完之後要「關掉這個工具再重開」才讀得到 —— 環境變數是程式啟動時拿到的一份拷貝，已經在跑的程式看不到後來設的值。',
    apiKeyRecheck: '我設好了，重新偵測',

    // ── agent 的模型（2026-09-10）─────────────────────
    agentModel: '模型',
    agentModelHint:
      '交給 CLI 的 --model。留白就是不帶這個參數，用 CLI 自己的預設 —— 那是一個有效的選擇，不是沒設定。',
    agentModelDefault: '留白 ＝ 用 CLI 自己的預設',
    embedBaseUrl: 'Ollama 位址',
    embedModel: '嵌入模型',
    embedModelPick: '選一個本機有的模型',
    /** 建議值是量出來的，而**畫面上要說得出「量了什麼」** */
    embedRecommend: '建議 {model}',
    embedRecommendWhy:
      '2026-09-09 拿 1955 段真實網頁與 50 條查詢比過七個候選；繁中查詢命中英文原文這一項它排第一（MRR@10 0.940，第二名 0.692）。小機器可以改用 qwen3-embedding:0.6b（610 MB）。',
    /** **這一句比那個下拉選單重要。** 換模型的代價要在按下去之前就看得到 */
    embedIrreversible:
      '換掉這個模型，已經算好的向量全部作廢，要整批重算 —— 而且比對不會報錯，只會安靜地變爛。三個角色裡只有這一個是這樣。',
    embedNotWired:
      '這裡選好之後，新匯入的資料就會算向量；已經匯入的要到搜尋面板按一次「建立語意索引」。換模型的話全部要重算。',
    agentCommand: 'CLI 指令',
    agentCommandHint: '留空就是不啟用。預設是 claude，靠系統路徑找。',
    save: '儲存',
    saved: '已儲存',
    test: '實際打一次',
    testing: '打出去了，等回覆…',
    testOk: '成功，花了 {ms} 毫秒',
    testFailed: '失敗',
    /** agent 那個按鈕真的會花錢，**按之前要先講** */
    testCostsMoney: '這會真的呼叫一次，可能產生費用。',
    testCostsMoneyOnline: '這會真的呼叫線上端點，可能產生費用；也會重新量一次格式支援。',
    testFree: '本機模型，不會產生費用。',
    testJsonMode: '格式保證：{mode}',
  },

  common: {
    loading: '載入中…',
    close: '關閉',
    back: '返回',
  },
} as const;

/** 把 `{name}` 換成值。**訊息本身仍然只在這個檔案裡。** */
/**
 * 說明清單的取用。
 *
 * **key 是從 `legend-items.ts` 的陣列裡拿出來的字串**，所以型別檢查幫不上忙 ——
 * 它擋得住寫死的存取，擋不住一個資料驅動的 key。少一個 key 由
 * `tests/guards/legend-coverage.test.ts` 抓。
 *
 * 取不到時回 key 本身而不是空字串：**一個看得見的怪字比一片空白容易發現**。
 */
export function guideSection(key: string): string {
  return t.graph.guide.sections[key] ?? key;
}

export function guideItem(key: string): { readonly short: string; readonly long: string } {
  return t.graph.guide.items[key] ?? { short: key, long: '' };
}

export function fill(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? String(values[key]) : whole,
  );
}
