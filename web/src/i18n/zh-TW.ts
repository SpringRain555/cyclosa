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
    '這個專題現在的狀態做不了這個動作。最常見的是還有作業在跑 —— 先到「匯入與研究」把它跑完或取消，再試一次。',
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
  IO_PATH_TOO_LONG:
    '資料夾的路徑太長，Windows 開不了裡面的工作目錄。到設定頁「資料位置」把資料根搬到短一點的位置。',
  IO_SNAPSHOT_MISSING:
    '這一項的原始快照檔不見了，閱讀器打不開它。可以重新擷取，但原有的點註會標成「找不到原文位置」。',
  IO_SNAPSHOT_CORRUPT:
    '原始快照的內容跟當初存下來的不一樣 —— 快照本來不應該被改動。請確認是不是同步軟體或防毒動過它。',
  IO_UNEXPECTED: '存取檔案時出了預期外的問題。請把下面的識別碼交出來。',
  /** 伺服器沒有回話，所以**沒有識別碼可以交** —— 這一句不能叫人交識別碼（v0.24.3）。 */
  IO_SERVER_UNREACHABLE:
    '連不到 Cyclosa 的伺服器 —— 它可能已經結束了。重新執行 start_cyclosa.cmd 之後再開這一頁。如果不是你結束的，%LOCALAPPDATA%\\Cyclosa\\logs 裡的 server.log 與 server.err.log 會記著它為什麼停。',

  // ── 擷取 ──────────────────────────────────────────────
  FETCH_BAD_URL: '這不是一個網址。檢查看看是不是少了開頭的 https://，或貼到的是一段文字。',
  FETCH_DUPLICATE: '這一份已經在專題裡了，所以沒有再建一個節點。',
  FETCH_ROBOTS_DISALLOWED:
    '這個網站的 robots.txt 不允許抓取這一頁，所以跳過了。需要的話請自己開瀏覽器讀，再把內容貼進來。',
  FETCH_RATE_LIMITED:
    '對方限流了。已經照它說的等過、再試過，還是不行 —— 這個網域這一輪先不碰，其他網域照常。過一段時間再重跑這幾項。',
  FETCH_TIMEOUT: '連線逾時。可以重試這一項；反覆逾時通常是對方的問題。',
  FETCH_UPLOAD_TIMEOUT:
    '等不到這個檔案，這批匯入已自動結束。分頁可能已關閉或連線中斷；請重新選取還沒上傳的檔案。',
  FETCH_DNS: '找不到這個網域。檢查網址有沒有打錯，或網路是不是斷了。',
  FETCH_TLS: '這個網站的憑證驗證不通過，所以沒有抓。這個工具不提供忽略憑證的選項。',
  FETCH_HTTP_4XX: '對方回覆找不到或拒絕存取。404 通常是頁面沒了，403 常見於需要登入。',
  FETCH_HTTP_5XX: '對方的伺服器出錯了。稍後重試這一項。',
  FETCH_TOO_LARGE: '這個檔案超過單檔上限，跳過了。真的需要的話請自己下載後用檔案匯入。',
  FETCH_UNSUPPORTED_TYPE: '不支援這種檔案型別。目前支援網頁、Markdown、純文字、PDF 與圖片。',
  FETCH_LOGIN_REQUIRED:
    '這一頁需要登入或訂閱才能看。這個工具不會繞過登入與付費牆 —— 請自己登入後另存再匯入。',
  /** **不要寫成「被擋下來」** —— 使用者要知道的是「登入沒有用，得自己用瀏覽器拿」。 */
  FETCH_BOT_CHALLENGE:
    '對方回的是一張「證明你不是機器人」的驗證頁，不是內容，所以沒有存進來。登入也沒有用 —— 請自己用瀏覽器打開那一頁，存成檔案後再匯入。',
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
    '這個專題有一部分資料的向量是另一個嵌入模型算的，那幾份不參與這次的語意比對（硬比會得到一個看起來正常的錯答案）。到搜尋面板按「建立語意索引」用現在的模型重算。',
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
  RUN_ALREADY_SETTLED:
    '這批匯入已經結束（取消了，或太久等不到下一個檔），這個檔沒有收進去。還沒傳的檔請重新選取。',
  RUN_STILL_ACTIVE: '這次作業還在跑，沒辦法復原。先按取消，或等它跑完再試。',
  RUN_OWNED_BY_RESEARCH:
    '這一筆作業屬於一次還沒結束的研究。先在「匯入與研究」把那次研究做完或放棄，再復原它。',
  RUN_UNEXPECTED: '處理這次作業時出了預期外的問題。請把下面的識別碼交出來。',
  RESEARCH_NOT_FOUND: '找不到這次研究。它可能屬於另一個專題，或是已經被刪掉了。',
  RESEARCH_ALREADY_OPEN:
    '這個專題已經有一次研究還沒結束。先把它做完，或在那一筆上按「放棄這次研究」，才能再開一次。',
  RESEARCH_STEP_INVALID: '這一步在目前這個階段做不了。重新整理這一頁，看看它現在停在哪一步。',
  RESEARCH_CANDIDATE_NOT_FOUND:
    '找不到這一筆候選。重新整理這一頁 —— 它可能屬於另一次研究，或那次研究已經被刪掉了。',
  RESEARCH_CANDIDATES_OVERFLOW: '這條方向找到的超過一次留得下的上限，只留了前面那幾份。',
  RESEARCH_UNEXPECTED: '處理這次研究時出了預期外的問題。請把下面的識別碼交出來。',
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
    /**
     * 模型那一類的錯誤帶著「是哪一個任務」（閘門一同時檢查找來源與初讀兩個）。
     * **說得出是哪一列、去哪裡改**，不是只說「模型還沒有設定」。
     */
    task: '哪一個任務',
    taskWhere: '到設定頁「模型分工」那一列改',
  },
  itemStatus: {
    pending: '待處理',
    fetched: '已擷取',
    parsed: '已解析',
    included: '已納入',
    excluded: '已排除',
    failed: '失敗',
  },

  /**
   * 一次作業的五種收尾狀態。**`partial` 不是「失敗」的一種** —— 它是「做出了東西，
   * 但有幾項沒成或有保留」。畫面上叫「部分完成」不叫「部分失敗」：
   * 2026-09-18 一次擴展寫進 6 份資料、50 條關聯，只因為幾條引文找不到就標成
   * 「部分失敗」，旁邊卻寫著「成功 1、失敗 0」。文件裡「部分失敗是一等公民」
   * 那句講的是原則（單項失敗不拖垮整批），名字留著；使用者看到的字改掉。
   */
  runStatus: {
    queued: '排隊中',
    running: '執行中',
    done: '已完成',
    partial: '部分完成',
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
    empty: '這個專題還沒有任何資料。到「匯入與研究」貼一個網址或拖一個檔案進來。',
    pickOne: '從左邊選一份來讀。',
    position: '第 {index} 份，共 {total} 份',
    // 資料節點之間的移動。**不要拿這兩句去當翻頁鈕** —— 2026-09-18 真的發生過：
    // PDF 的翻頁鈕借了「上一份／下一份」，使用者只有一份資料，於是以為 35 頁只有第一頁。
    previous: '上一份資料',
    next: '下一份資料',
    sortRecent: '最近匯入',
    sortTitle: '依標題',
    filterAll: '全部',
    filterLowConfidence: '只看低信心',
    filterUnread: '只看未讀',
    loadMore: '載入更多',
    source: '來源',
    /** 你上傳的那一份是替哪個網址拿的（研究的「對回候選上傳」，R10）。 */
    uploadedFor: '對應網址',
    /** 研究的候選還沒確認（ADR-0033 D8）。**確認之前不會從它抽任何關聯** —— 那句話要在。 */
    candidateOf: '候選 · 研究「{topic}」還沒確認。確認之前，不會從這一份抽出任何關聯。',
    fetchedAt: '快照時間',
    language: '語言',
    unknownLanguage: '判不出來',
    size: '大小',
    pages: '共 {n} 頁',
    pageCount: '頁數',
    /** 連續捲動裡每一頁前面那一條分隔（v0.24.0）；點註仍照 ADR-0019 錨在頁碼＋頁內區間。 */
    page: '第 {n} 頁',
    /** 跨頁的選取做不成點註：錨點是「頁碼＋頁內區間」，一則點註只能在一頁上。 */
    crossPage: '選取跨了兩頁，點註一次只能在一頁上 —— 請在同一頁裡選。',
    /** 抽取器升版之後、按「重算全部正文」之前，舊版的產物還讀得到，但要說出來。 */
    staleDerived:
      '這一份的正文是舊版抽取器抽的（PDF 每一行都硬斷）。到「匯入與研究」按「重算全部正文」會重排成段落。',
    openSnapshot: '看原始快照',
    original: '原文',
    translated: '繁體中文',
    noTranslation: '這一份還沒有譯文。',
    translationLabel: '標題與摘要用哪一種語言',
    translationNotice: '這是譯文，由 {model} 於 {date} 產生。原文永遠保留，點註錨在原文上。',
    markRead: '標記為已讀',
    markUnread: '標記為未讀',
    read: '已讀',
    exclude: '排除這一份',
    restore: '復原',
    retry: '重試',
    excluded: '這一份已被排除，不會出現在圖上。',
    failedNotice: '這一份沒有抽取成功。原始快照還在，可以直接看它。',
    noContent: '沒有重構後的正文。原始快照還在。',
    referenceOnly: '這一筆只有書目、沒有正文。',
    openSourceUrl: '開啟原網址',
    imageOnly: '這是一張圖片。',

    // ── PDF 的兩種檢視（v0.24.1）──────────────────────────
    //
    // 2026-09-19 使用者：「閱讀器無法顯示圖片，也無法正常顯示數學公式」。抽出來的正文本來就沒有圖，
    // 所以 PDF 多一種「版面」檢視（pdf.js 照原檔畫），原本那一種叫「文字」。點註兩邊通用。
    viewLayout: '版面',
    viewText: '文字',
    viewLabel: '這一份怎麼顯示',
    viewLayoutWhat: '照原檔畫出來：圖、公式、表格都在。選一段字就能存成點註。',
    viewTextWhat:
      '從 PDF 抽出來、重排成段落的文字：沒有圖，公式可能是散的，窄畫面比較好讀。點註兩邊通用。',
    layoutLoading: '正在畫這份 PDF…',
    layoutFailed: '這份 PDF 畫不出來（{reason}）。改用「文字」檢視，或按「看原始快照」。',
    /** 選取換算不回正文的位置（`layer-map.ts` 回 not-found）。**不猜一個位置存下去。** */
    layoutUnmatched:
      '選到的這一段在正文裡對不到位置，沒辦法存成點註 —— 改在「文字」檢視裡選。這一份若標著舊版抽取器，先到「匯入與研究」按「重算全部正文」。',
    layoutNoText:
      '這份 PDF 沒有文字層（多半是掃描件）：看得到版面，但選不了字，也就做不成點註。不是工具壞了。',
    layoutPage: '第 {n} / {total} 頁',
    zoomIn: '放大',
    zoomOut: '縮小',
    zoomFit: '適合寬度',
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
    /** 關聯的引文（v0.24.0）：位置是「在正文的第幾個字」，正文一變就要對回去。 */
    evidenceOk: '{n} 條關聯引文全部對得上原文。',
    evidenceShifted: '{n} 條關聯引文的位置移動過（已經跟著改）。',
    evidenceUnresolved:
      '{n} 條關聯引文在新的正文裡找不到 —— 引文與關聯都留著，匯出時會標成回溯不到。',
  },

  /** 來源網站清單。 */
  sources: {
    title: '來源網站',
    intro:
      '這一頁決定 agent 優先往哪裡找。它不擋任何東西 —— 讀不到的來源仍然會出現在清單上，只是不優先。',
    /**
     * 兩件常見的維護要說做法，因為直覺的做法（改網域）沒有提供：
     * 網域是鍵，抓過的紀錄跟著它，改了鍵紀錄就斷了。
     */
    maintain:
      '網站換了網址：加一列新的、把舊的關掉，舊的備註寫「已改到哪裡」—— 抓過的紀錄跟著網域走，所以不提供改網域。網站結束營運：關掉並寫備註。',
    /** 判斷的依據要說出來，因為「探測」與「你自己抓過」的可信度差很多。 */
    basisHistory: '依你抓過的 {n} 次',
    basisProbe: '依一次檢查',
    basisNone: '還沒有依據',
    access: {
      open: '讀得到',
      login: '要登入或訂閱',
      challenged: '對方出驗證頁',
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
    /** 一列一個鍵 —— `tests/domain/sources-and-identity.test.ts` 逐行掃這一塊。 */
    kind: {
      api: 'API',
      site: '網站',
    },
    /**
     * 「類型」是固定的一組（`SOURCE_CATEGORIES`），因為它驅動行為 —— 出版社沒探針、API 才有探針。
     * 「領域」（資安、生醫…）是另一條軸，自由多值，**不在這裡**：它跟名稱一樣是資料，存中文字串。
     * `tests/domain/sources-and-identity.test.ts` 守著這一組跟程式那一組一致。
     */
    category: {
      'scholarly-api': '書目 API',
      preprint: '預印本',
      'open-repository': '開放全文庫',
      publisher: '出版社',
      official: '官方',
      reference: '參考',
      'security-news': '資安新聞',
      'vulnerability-db': '漏洞資料庫',
      community: '社群論壇',
    },
    /** 三欄（v0.24.0）：抓過的次數在「依據」那一句裡，檢查時間併進狀態那一格。 */
    columns: {
      site: '來源',
      status: '現在讀不讀得到',
      actions: '',
    },
    lastChecked: '上次檢查 {when}',
    /** 分組表頭：類型名稱 ＋ 這一組有幾列。 */
    groupCount: '{n} 個',
    /** 從抓取紀錄長出來的那幾列自成一組 —— 它們的類型是填的不是知道的，不該混進任何一組。 */
    groupDiscovered: '從你的抓取紀錄長出來的',
    countLine: '顯示 {visible}／{total} 列，其中 {enabled} 列打開',
    search: '搜尋名稱、網域或備註',
    fieldsAll: '全部領域',
    /** 篩選 chips 上方那一句。「領域」一詞要跟編輯表單的欄位名一致。 */
    fieldsLabel: '領域',
    onlyEnabled: '只看打開的',
    noMatch: '沒有符合的來源。',
    edit: '編輯',
    save: '儲存',
    cancel: '取消',
    remove: '刪除',
    /** 內建的列按「刪除」只會關掉 —— 畫面上要說同一句話，不然使用者會以為它壞了。 */
    removeBuiltIn: '「{name}」是內建的，刪不掉 —— 只會關掉，下次升級它還會在清單上。要關掉它嗎？',
    removeBuiltInOff: '「{name}」是內建的，刪不掉；它現在已經是關掉的。',
    removeConfirm: '要把「{name}」從清單上拿掉嗎？抓過的紀錄還在，只是這一列不再顯示。',
    fieldName: '顯示名稱',
    fieldKind: '型別',
    fieldCategory: '類型',
    fieldFields: '領域（逗號分隔，例如「資安, 資訊科學」）',
    fieldProbe: '探針網址（選填；只有文件寫明的 API 端點才填）',
    fieldNote: '備註',
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
      reference: '書目',
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
    embedOtherModel:
      '這個專題有一部分資料的語意索引是另一個嵌入模型算的，現在的模型比不到它們（兩個模型的向量不能拿來比）。按上面的「建立語意索引」用現在的模型重算。',
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
    /**
     * 關掉之後整頁換成這個 —— **因為這一頁上其餘的東西已經全部失效了**。
     * 留著原本的畫面比較糟：每一顆按鈕看起來都還能按，按下去才發現連不上。
     */
    doneTitle: 'Cyclosa 已經關掉了',
    /**
     * 沒有「關閉這個分頁」的按鈕（v0.23.0 拿掉）：`window.close()` 對啟動器開的分頁無效，
     * 一顆按了沒反應的按鈕就是壞掉的按鈕。這句話直接請使用者自己關。
     */
    doneBody:
      '資料都已經存好，下次啟動接得回來。這個分頁可以直接關掉 —— 要再用的時候，雙擊 start_cyclosa.cmd 就會重新開起來。',
    failed: '關不掉。先重新整理看看它是不是其實已經停了；還在的話，用工作管理員結束 node.exe。',
  },

  runs: {
    noticeTitle: '專題升級通知',
    noticeDismiss: '知道了',
    noticeUnknown: '這個專題有一則升級通知；目前無法顯示詳細內容。',
    noticeCleanup:
      '已清除 {deletedRuns} 筆舊擴展作業、{deletedItems} 份資料與 {deletedEdges} 條關聯。留下 {keptItems} 份資料與 {keptEdges} 條人建立或裁決過的關聯：讀過 {read} 份、點註過 {annotated} 份、排除過 {excluded} 份；另外 {referenced} 份仍是留下的關聯的出處或端點。其中 {otherRuns} 份是別的作業還在用。原因可能重疊，不能直接相加。手動抽取保留，快照不動。',
    tab: '匯入與研究',
    title: '歷次紀錄',
    empty: '還沒有任何作業。貼一個網址或拖一個檔案進來就會開始。',
    newImport: '匯入',
    urlsLabel: '貼上網址（一行一個）',
    urlsPlaceholder: 'https://example.com/一篇文章',
    submitUrls: '開始匯入',
    dropHint: '或把檔案拖到這裡（網頁存檔、Markdown、純文字、PDF、圖片）',
    picking: '選檔案（可多選）',
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
    // 跑完之後回到圖上看：焦點放在這一次新增關聯最多的那一份。
    showOnGraph: '在關聯圖上看這一次抓到的',
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
    undoKept: '留下 {items} 份資料與 {edges} 條關聯 —— 你動過它們，或仍有關聯在用。',
    undoKeptEvidence: '其中 {n} 份是因為留下的關聯仍靠它當出處或端點（包含別的作業）。',
    /** 研究還沒結束的作業不能復原（`RUN_OWNED_BY_RESEARCH`）—— **不給一顆按了必定報錯的按鈕**，說為什麼。 */
    heldByResearch:
      '這一筆屬於一次還沒結束的研究 ——「匯入與研究」上面那一次做完或放棄之後，才能復原它。',
    undoNothing: '這次作業沒有東西可以刪了。',
    /** 產生了角度、還沒勾的那種。**它什麼都沒抓、什麼都沒寫**，所以可以直接丟。 */
    draft: '草稿 · 還沒開始',
    discard: '丟掉',
    discardConfirm: '丟掉這筆草稿？它還沒抓任何東西，丟掉不會動到專題裡的任何資料。',
  },

  graph: {
    tab: '關聯圖',
    empty: '這個專題還沒有任何資料。到「匯入與研究」貼一個網址或拖一個檔案進來。',
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
      /**
       * 按鈕顯示的是**按下去會變成的那一邊**。
       * 用「檢視」不用「模式」：同一頁的搜尋面板已經有三種「模式」（全文／語意／兩者），
       * 而這顆鈕改的是你怎麼看，資料一個都不動（ADR-0007「3D 只做瀏覽」）。
       */
      flat: '2D 檢視',
      solid: '3D 檢視',
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
        nodeReference: {
          short: '書目（虛線稜線）',
          long: '只有書目、沒有正文。方形、資料藍的虛線稜線加淡填，與實體的灰色實線框不同。有網址可從節點面板開啟。',
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
      reference: '書目',
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
    legacy: '舊版流程。新的「研究」在上面那一塊 —— 它會先跟你談出方向，花錢之前停下來等你。',
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

  /**
   * 研究（v0.25.0，ADR-0033）。**這一版只到閘門一。**
   *
   * 每一句都要能回答「現在花了什麼」—— 這個流程存在的理由就是「花錢之前停下來」。
   */
  research: {
    title: '新的研究',
    topicLabel: '這次想研究什麼',
    topicPlaceholder: '一個主題、一個問題、一個人',
    start: '開始',
    starting: '正在查你已經有的資料…',
    /** **這一句在按任何會花錢的按鈕之前就出現** —— 它算的是本機索引。 */
    freeHint: '按下去只會查你已經有的資料，不花錢。',
    hitsSome: '你已有的 {total} 份裡，{n} 份提到它',
    hitsNone: '你已有的 {total} 份都沒有提到它 —— 這是一個新的方向。',
    hitsEmptyCase: '這個專題還沒有任何資料 —— 這是一個全新的方向。',
    /** 開起來之後停在規劃，畫面要說清楚接下來有兩條路。 */
    planTitle: '規劃',
    planEmpty: '還沒有方向。跟模型談一輪，或自己加一條。',
    sayLabel: '跟模型說',
    sayPlaceholder: '例如：我要的是標準文件，不是新聞報導',
    say: '談一輪',
    saying: '模型在想…',
    sayCosts: '談一輪會用到「{service}」上的 {model}，這一步會花錢。',
    sayFree: '談一輪會用到本機的 {model}，不花錢。',
    noBrowse: '這個服務不會上網查 —— 它只能用你專題裡已經有的東西談。',
    you: '你',
    model: '模型',
    failedTurn: '這一輪沒有交出可以用的規劃。',
    relation: '跟這個專題的關係',
    outOfScope: '刻意不查',
    overflow: '模型提的比一次放得下的多，多出來的沒有留 —— 上限是 {n} 條。',
    edited: '你改的',
    directionWhat: '要找什麼',
    directionExpect: '預期來源',
    directionKeywords: '關鍵詞',
    addDirection: '自己加一條',
    newDirection: '新的方向',
    removeDirection: '刪掉',
    saveDirections: '存下改過的方向',
    savingDirections: '存著…',
    directionsFree: '改方向不花錢。',
    /** 閘門一。**按下去之前什麼都還沒抓** —— 這句話是 REQ-0009 R5 的驗收條件。 */
    gateOne: '照這份規劃開始',
    gateOneHint: '按下去之前，一次搜尋、一次擷取都還沒有發生。',
    gateOneNext:
      '按下去之後會照這 {n} 條方向去找來源，把找到的抓回來，再把拿到的每一份初讀一次（有沒有關、繁中標題與摘要）。',
    /** 閘門旁邊先說接下來哪幾步花錢、走哪個服務（ADR-0033 D2）。 */
    gateOneRuns: '接下來會跑：找來源（{find}）、抓取（不花錢）、初讀（{digest}）。',
    serviceCosts: '「{service}」· 會花錢',
    serviceFree: '「{service}」· 不花錢',
    gateOneNotReady: '至少要有一條方向。',
    frozenNotAdopted: '沒採用',

    // ── 蒐集（Stage 20）──────────────────────────────────
    collectTitle: '蒐集',
    collectLive:
      '正在照方向找來源，找到的一份一份抓回來，拿到的每一份讀一次。抓到的現在就可以在閱讀器裡讀。',
    collectPaused: '暫停中 —— 正在做的那一步做完就停在這裡。',
    /** 程式關掉的時候蒐集還沒做完（D3、R13）。**已抓的都還在**，這句話要說出來。 */
    collectInterrupted:
      '蒐集停在半路 —— 上次關掉程式的時候它還沒做完。已經抓到的都還在，按「繼續蒐集」會接著做，不會重抓。',
    awaitingTitle: '輪到你',
    awaitingBody:
      '能抓的都抓了。「要你拿」的那幾份，拿到了就在那一列上傳；拿不到就標原因。都處理好（或決定不處理）就按「完成蒐集」。',
    awaitingCancelled: '你按了取消 —— 還沒做的那幾步，按「繼續蒐集」會接著做。',
    awaitingFailed: '蒐集這一筆作業停下來了：{reason}',
    /** 還沒做完的那幾種，**只列不是 0 的**（「0 條方向還沒搜成」是一句沒有用的話）。 */
    workLeft: '還沒做完：{parts}。',
    workSearches: '{n} 條方向還沒搜成',
    workFetches: '{n} 份還沒抓',
    workDigests: '{n} 份還沒讀',
    resume: '繼續蒐集',
    /** 「繼續蒐集」旁邊那句：**會做的每一步各自說走哪個服務、花不花錢**。 */
    resumeSearch: '沒搜成的那幾條再搜一次（{service}）',
    resumeFetch: '要抓的照舊抓（不花錢）',
    resumeDigest: '拿到的讀一次（{service}）',
    resumeParts: '按下去：{parts}。',
    /** 閘門二（R12）。 */
    gateTwo: '完成蒐集',
    gateTwoHint:
      '按下去之後不再找、不再抓新的。還沒拿到的那幾份，下一步（確認）會預設成「只留書目」。',
    gateTwoLive: '蒐集還在跑 —— 等它做完，或先按「取消這次作業」。',
    /** 閘門二之後：確認與建圖還沒接上（Stage 22）。**照實說**。 */
    reviewingTitle: '蒐集完成',
    reviewingBody:
      '確認每一份要不要進圖、以及建圖那兩步還沒做進這一版 —— 它們是下一步。抓回來、上傳進來的現在都可以在閱讀器裡讀。',

    // 一條方向那一列（**數的，不叫模型說**，ADR-0033 D10）
    directionPending: '還沒搜',
    directionQueued: '等著搜',
    directionSearching: '搜尋中…',
    directionFailed: '沒搜成：{reason}',
    tally: '找到 {found}、拿到 {acquired}',
    tallyNeedsUser: '要你拿 {n}',
    tallyUnavailable: '拿不到 {n}',
    tallyPending: '還沒抓 {n}',
    noCandidates: '這條方向沒有找到任何來源。',
    sharedElsewhere: '另外 {n} 份也被別的方向找到，列在那一條底下。',

    // 一列候選
    acquisition: {
      found: '還沒抓',
      fetching: '抓取中',
      fetched: '抓到了',
      'needs-user': '要你拿',
      uploaded: '你上傳了',
      unavailable: '拿不到',
    },
    /** 抓之前的預期 —— **依你的紀錄**，不是模型說的。 */
    expectedLabel: '預期',
    expected: {
      open: '公開',
      login: '多半要登入',
      blocked: '工具多半抓不到',
      unknown: '不知道',
    },
    /** R8：依你的紀錄沒去試。**說得出為什麼沒試**，不是一個安靜的「要你拿」。 */
    skippedLogin: '沒去抓：依你的紀錄，{host} 多半要登入。',
    skippedBlocked: '沒去抓：依你的紀錄，{host} 會出驗證頁。',
    alsoFoundBy: '另外 {n} 條方向也找到它',
    /** 初讀（Stage 21）。判斷是模型的意見 —— 畫面上說「初讀」而不是「有關」兩個字單獨站著。 */
    relevance: {
      yes: '初讀：有關',
      no: '初讀：沒關',
      unsure: '初讀：說不準',
    },
    digestPending: '還沒讀',
    digestQueued: '等著讀',
    digestFailed: '沒讀成：{reason}',
    /** R15：繁中是衍生物，**說得出是誰、什麼時候產生的**。 */
    digestBy: '繁中由 {model} 於 {date} 產生',
    openInReader: '在閱讀器裡讀',
    upload: '上傳',
    uploading: '上傳中…',
    uploadHint: '你自己拿到的那一份對回這一列。出處仍然指得回這個網址。',
    unavailableLabel: '拿不到的原因',
    /** 原因收在這顆按鈕後面（設計稿的「拿不到 ▾」）—— 每一列都攤開一個下拉選單太重。 */
    unavailableOpen: '拿不到…',
    unavailableClose: '收起來',
    unavailableReasons: {
      paywall: '付費牆／沒帳號',
      'not-found': '找不到這一份（可能是模型編的）',
      blocked: '被擋',
      other: '其他',
    },
    notePlaceholder: '寫一句為什麼',
    markUnavailable: '標成拿不到',
    unavailableShown: '拿不到：{reason}',
    reopen: '改回要你拿',

    abandon: '放棄這次研究',
    abandoned: '放棄了',
    remove: '刪掉這次研究',
    removeHint:
      '刪的是對話、規劃、方向與候選的紀錄，以及那一次的模型呼叫紀錄。抓回來、上傳進來的資料留在專題裡。',
    costSoFar: '到目前為止花了 {usd} 美元',
    costUnknown: '有 {n} 次沒有回報金額',
    costNone: '目前還沒有花錢',
    /** 逐任務（R29）：「規劃 0.02、找來源 0.10、初讀 0.00」。沒回報過的寫「不知道」，不寫 0。 */
    costTasks: {
      plan: '規劃',
      'find-sources': '找來源',
      digest: '初讀',
      extract: '抽取',
    },
    costTaskItem: '{task} {usd}',
    costTaskUnknown: '{task} 不知道',
    costBreakdown: '（{parts}）',
    /** 作業紀錄那一頁：研究的蒐集作業那一列。 */
    runLabel: '研究 · {topic}',
    /** 這一筆的「一項」是一次模型呼叫：一條方向的搜尋，或一份的初讀（Stage 21）。 */
    runCounts: '搜尋與初讀做成 {succeeded} 次、沒做成 {failed} 次；抓了 {fetched} 份',
    /** 歷次紀錄那一欄。 */
    listTitle: '歷次研究',
    listEmpty: '還沒有任何研究。',
    status: {
      planning: '規劃中',
      collecting: '蒐集中',
      'awaiting-user': '等你',
      reviewing: '確認中',
      building: '建圖中',
      done: '已完成',
      abandoned: '放棄了',
    },
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
      moveBusyRuns: '還有作業在跑的時候不能搬。先到「匯入與研究」把它跑完或取消。',

      // ── 範例專題 ──────────────────────────────────────
      sampleTitle: '範例專題',
      sampleWhat:
        '第一次啟動時會放一份範例專題，裡面是八條中華民國法律的條文原文，每一份都指得回它自己那一條的網址。刪掉之後不會自己回來 —— 要的話按這裡。',
      sampleLicence:
        '語料來自全國法規資料庫的官方開放資料（政府資料開放授權條款第 1 版）。條文原文依著作權法第 9 條本來就不是著作權的標的。',
      /** **這句話一定要說。** 那四條已確認的關聯不是誰真的裁決過的紀錄。 */
      sampleNotReal: '範例裡標成「已確認」的關聯是示範資料，不是任何人真的裁決過的紀錄。',
      sampleBuild: '重建範例專題',
      sampleBusy: '建立中⋯',
      sampleDone: '範例專題已建立：{items} 份資料、{entities} 個實體、{edges} 條關聯。',
      sampleExists: '已經有一份範例專題了。要重建的話先把它刪掉。',
    },
    /**
     * 頂列那個點旁邊的字 —— **要在按下去之前看得到，不是想起來的時候。**
     * 三種：實心（每個設了的任務都跑得動）、空心（一個都沒設）、虛線（有一個跑不動）。
     */
    topbar: {
      ready: '模型可以用',
      none: '還沒設定模型',
      problem: '有模型連不上或配不上',
    },
    version: '版本',
    versionUnknown: '問不到版本',
    /** 不自動降級是 ADR-0006 的決定，畫面上要說得出來 */
    noFallback: '配不上就停手，不會自動換一個能力較弱的來跑。',

    // ── 段落一：模型分工（v0.24.0 一張表，ADR-0032；v0.24.2 改名並加「儲存並測試」）──
    //
    // **主鍵是任務。** v0.10.6–v0.23.0 的設定頁是「三個角色各一格 ＋ 一張逐任務覆寫表」，
    // 使用者第一次真的用（2026-09-18）問「這兩個是不是重複」—— 它們講的是同一件事的兩半。
    // 現在只有一張表：每一列說走哪一個服務、用哪個模型、現在跑不跑得動。
    // 2026-09-19 使用者挑的名字：這一區叫「模型分工」、下面那一區叫「模型服務」，
    // 那一欄叫「服務」；右上角一顆「儲存並測試」，按下去先存、再逐任務真的打一次。
    sectionTasks: '模型分工',
    sectionTasksWhat: '每個任務交給哪個服務上的哪個模型做。服務在下面設定一次，這裡挑。',
    testAll: '儲存並測試',
    testAllWhat:
      '「儲存並測試」會先存這一頁，再對每一個設好的任務真的打一次。Claude Code 與線上服務會花錢，本機不會。',
    testAllBusy: '測試中（{done}／{total}）…',
    testAllDone: '{ok}／{total} 個任務能用（{time}）',
    testSkipped: '還沒設定，略過',
    taskTableHead: {
      task: '任務',
      via: '服務',
      model: '模型',
      status: '狀態',
    },
    taskNames: {
      plan: '規劃對話',
      'find-sources': '找候選來源',
      digest: '初讀抓回來的資料',
      angles: '歸納切入角度',
      extract: '從正文抽實體與關係',
      embed: '算語意檢索的向量',
    },
    taskWhat: {
      plan: '跟你來回談出這次研究要往哪幾個方向蒐集。Claude Code 與 OpenAI 相容 API 可以邊查邊談，Ollama 只能談。',
      'find-sources': '用網頁搜尋找出候選網址。它不抓網頁 —— 抓取一律走同一條擷取管線。',
      digest:
        '研究抓回來（或你上傳）的每一份讀一次：跟這次研究有沒有關、繁中標題與兩三句繁中摘要。只讀正文開頭，不翻全文，原文不動。',
      angles: '從專題裡已經有的內容歸納出幾條可以往下查的子問題。',
      extract: '把抓回來的正文變成實體與帶引文的關聯 —— 圖上長出什麼由這一步決定。',
      embed: '把正文與問句都變成向量，讓用字不同的東西也找得到。換掉要全部重算。',
    },
    /** 服務只能選一種的任務，那一格要說為什麼 —— 一個不能動的下拉選單看起來像壞了。 */
    viaFixed: {
      embed: '只准本機 —— 換端點向量就作廢',
    },
    taskState: {
      ready: '可以用',
      'not-configured': '還沒設定',
      unreachable: '連不上',
    },
    /** 模型欄空著的時候的提示。CLI 那一列空著是一個有效的選擇。 */
    modelPick: '選一個',
    modelPickText: '輸入模型名稱',
    modelUnlisted: '這個服務的模型清單還沒列出來 —— 先在下面按「儲存並檢查」，或直接輸入名稱。',
    agentModelDefault: '留白 ＝ 用 CLI 自己的預設',
    agentModelHint:
      '交給 CLI 的 --model。留白就是不帶這個參數，用 CLI 自己的預設 —— 那是一個有效的選擇，不是沒設定。',
    /**
     * **這一句比那個下拉選單重要。** 換模型的後果要在按下去之前就看得到。
     * v0.24.0 之前這裡寫「向量全部作廢、比對只會安靜地變爛」—— 兩句都不對：向量照模型分開存，
     * 檢索只拿同一個模型算的比（`vector-reader.ts`）。
     * **2026-09-29 再更正一次**：v0.24.1 起這裡寫「舊模型的向量留著，換回來就能用」，而 `replaceVectors`
     * 是**一份資料一份資料整份換掉** —— 用新模型重算過的那幾份，舊模型的向量就不在了。還沒重算的才留著。
     * 改了就存、不加確認框的理由仍然成立：換回來之後，按一次「建立語意索引」就回到原樣。
     */
    embedSwitch:
      '換了這個模型，語意檢索要等新模型把向量算完才找得到東西（到搜尋面板按「建立語意索引」）。重算過的資料，舊模型的向量會被換掉；換回原本的模型要再算一次。',
    embedNotWired:
      '選好之後，新匯入的資料就會算向量；已經匯入的要到搜尋面板按一次「建立語意索引」。',
    /** 建議值是量出來的，而畫面上要說得出「量了什麼」。**只對走本機 Ollama 的任務顯示** */
    taskRecommend: '建議 {model}',
    taskRecommendWhy: {
      digest:
        '跟抽取的建議值同一個模型，一個常駐就夠 —— 抽取那一輪它照格式交回、不捏造原文沒有的字（引文命中 93%）。初讀本身讀得準不準、繁中順不順，還沒有單獨量過。',
      angles:
        '2026-09-09 同一輪量測裡它給滿六條角度（多數模型只給四條），而且角度彼此的相似度最低（0.712）—— 那一欄量的是「多視角有沒有真的多視角」。5.3 GB，跟抽取的建議值是同一個模型。',
      extract:
        'IBM 的 granite4.2:8b（5.3 GB）。2026-09-29 拿 1957 段真實網頁量過 13 個本機模型，只收非中國來源、6 GB 以內：抽關聯六次全過、引文在原文裡找得到的比例 93%，平均每份 4.8 條關聯、14 秒。記憶體夠的話改用 gemma4:12b（7.6 GB）：每份 12.0 條、引文 93%、15 秒。',
      embed:
        'IBM 的 granite-embedding-311m-multilingual-r2（768 維、639 MB，上下文 32k）。2026-09-29 拿 1957 段真實網頁與 50 條查詢量過：只看非中國來源的模型，繁中查詢命中英文原文這一項它最好（MRR@10 0.766，第二名 0.688）—— 比以前的建議值差，繁中查英文會漏得多一些。要先用 ollama pull 拉這個名字。',
    },
    capabilities: '能力宣告',
    capabilityNames: {
      browse: '上網搜尋',
      tools: '工具呼叫',
      json_schema: '保證 JSON 結構',
      vision: '看得懂圖',
    },
    contextTokens: 'context {n} tokens',
    contextUnknown: 'context 大小不明',
    missing: '這個任務需要：{flags}，而目前設定的模型沒有。',
    /**
     * 「符合格式」由誰保證。事後檢查是一種降級，
     * 而它被允許的條件是說出來 —— 所以這一行一定要在。
     */
    jsonModeLabel: '格式保證',
    jsonMode: {
      schema: '由端點保證（json_schema）',
      object:
        '由 Cyclosa 事後檢查。這個端點只保證回一份 JSON，形狀不對的回應一律擋下來、不會寫進專題。',
      none: '這個模型在這個端點上連 JSON 都不保證，需要結構化輸出的任務跑不了。常見的原因是選到了不能對話的模型（例如嵌入模型）—— 下面那行是端點自己說的理由。',
      unchecked:
        '還沒量過。第一次真的跑任務時會先量一次（一到兩個很小的請求），也可以按「儲存並測試」現在量。',
    },
    jsonModeNative: '由協定保證（Ollama 的 format 是受限解碼）',
    jsonCheckedAt: '{date} 量的',
    /** OpenAI 相容 API 走哪一種協定 —— 使用者指定了 Responses API，所以走到哪一種要看得到（ADR-0034） */
    protocolName: {
      responses: 'Responses API',
      chat: 'Chat Completions（這個端點沒有 /responses）',
    },
    testOk: '成功，花了 {ms} 毫秒',
    testFailed: '失敗',
    testJsonMode: '格式保證：{mode}',
    /**
     * 「會不會上網搜尋」那一行（v0.24.2，ADR-0034）。CLI 是參數給的、不是量的；
     * OpenAI 相容 API 是量的 —— 真的搜尋了、交回的形狀也對才算。
     */
    browseLabel: '上網搜尋',
    browse: {
      declared: '由參數保證（--tools WebSearch）',
      /** 本機 Ollama 的規劃對話：**它就是不會上網查**，那不是量出來的，也不是壞掉。 */
      declaredNo: '這個服務不會上網查 —— 它只能用你專題裡已經有的東西談',
      yes: '量過會搜尋',
      no: '量過不會搜尋',
      unchecked: '還沒量。開始擴展之前會先量一次，也可以按「儲存並測試」現在量。',
    },
    testBrowse: '上網搜尋：{state}',

    // ── 段落二：模型服務（設定一次，上面挑）──
    //
    // 2026-09-19 使用者說三個區塊分不清、用詞不一致。現在三塊各自框起來、名字都是產品名
    // （Claude Code、Ollama、OpenAI 相容 API），「本機或線上、花不花錢」寫在名字底下那一行；
    // 每一塊右上角一顆「儲存並檢查」—— 先存這一塊，再看連不連得上、有哪些模型。
    sectionConnections: '模型服務',
    sectionConnectionsWhat: '三種各設定一次；「模型分工」每一列從這裡挑。',
    connectionNames: {
      cli: 'Claude Code',
      ollama: 'Ollama',
      openai: 'OpenAI 相容 API',
    },
    /** 名字底下那一行：在哪裡跑、花不花錢。 */
    connectionKind: {
      cli: '這台電腦上的 claude 指令 · 用你登入的帳號，吃訂閱額度',
      ollama: '這台電腦上的模型伺服器 · 不花錢',
      openai: '線上服務、訂閱的代理，或別家本機伺服器 · 線上的可能花錢',
    },
    connectionWhat: {
      cli: '跑 claude -p，會上網搜尋（我們只給它搜尋這一個工具）。留空就是不啟用。',
      ollama:
        '開著 Ollama 就能用：預設位址就是它的預設埠 11434，只有改過 OLLAMA_HOST 才需要改這一格。走它自己的協定，才關得掉模型的思考、指定得了 context 大小 —— 兩件事都量過會影響結果。',
      openai:
        '位址照那一家的文件寫，通常以 /v1 結尾（vLLM、LM Studio 也是）。先走 Responses API（有網頁搜尋工具），沒有那條路的端點才退回 Chat Completions；走到哪一種，上面那張表的「格式保證」會寫。',
    },
    connState: {
      ready: '連得上',
      'not-configured': '還沒設定',
      unreachable: '連不上',
    },
    cliFound: '找得到',
    modelCount: '{n} 個模型',
    /** 「儲存並檢查」：先存這一塊，再看連不連得上、有哪些模型。跟「儲存並測試」分開：檢查不花錢，測試會。 */
    listModels: '儲存並檢查',
    listing: '檢查中…',
    listedOk: '連得上，列出 {n} 個模型（{time}）',
    listedNone:
      '連得上位址，但列不出模型。檢查位址（OpenAI 相容 API 通常以 /v1 結尾），以及金鑰那個環境變數有沒有設。',
    checkedCli: '{summary}（{time}）',
    checkHeld: '金鑰變數的名字不合格，改好之前不會儲存，也就檢查不了。',
    listStale: '位址或金鑰變數改了 —— 上面選模型之前先按「儲存並檢查」。',
    cliCommand: '指令',
    cliCommandHint: '預設是 claude，靠系統路徑找。也可以填完整路徑。',
    baseUrl: '位址',
    openaiBaseUrlPlaceholder: 'https://api.example.com/v1',
    /** 金鑰只從環境變數讀，不存進任何一個檔。 */
    apiKeyEnv: '金鑰的環境變數名稱',
    apiKeyEnvHint:
      '只填變數的名字（例如 OPENAI_API_KEY），不要填金鑰本身 —— 這個設定檔會被備份，也會在求助時被整份貼出來。留空代表不帶金鑰。',
    /**
     * **這一句要說出兩件事**：為什麼擋（不是刁難打字），以及怎麼繞過去。
     * 沒有後半的話，一個變數真的叫小寫名字的人會以為這裡不支援他。
     */
    apiKeyEnvBad:
      '這個名字不會被存起來。只收英文字母、數字與底線，而且開頭要是英文字母（小寫會自動轉成大寫 —— Windows 的環境變數不分大小寫）。這是為了擋住有人把金鑰本身貼進這一欄：真的金鑰有減號、而且很長。',
    auth: {
      none: '不帶金鑰',
      'env-set': '偵測到這個環境變數',
      'env-missing': '找不到這個環境變數 —— 設好之後要重新啟動這個工具。',
    },
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

    // ── 段落三：診斷：留下模型呼叫的紀錄（2026-09-18）─────────
    //
    // **這一區的每一句都在講代價**，因為預設是關的、而打開它要有理由。
    diagnosticsTitle: '診斷',
    logModelCalls: '留下每一次模型呼叫的紀錄',
    logModelCallsWhat:
      '記的是找來源、歸納角度、抽取這三個任務：當時送出去的完整提示詞、模型回的東西、用的是哪一個模型、走的是哪一條連線、花了多久。語意向量那一個不記 —— 它的輸出是一串數字，當文字看沒有意義。',
    logModelCallsWhere:
      '存在那個專題自己的資料夾裡（model-calls，一個作業一個檔，一行一次呼叫），所以它跟著專題一起備份、一起刪掉。金鑰不會進去，只記端點的網域。',
    logModelCallsCost:
      '它長得很快 —— 抽取那一次的提示詞裡是整份正文。平常關著，遇到一個抽錯的結果想查清楚為什麼的時候再打開。',

    /**
     * **改了就存，沒有儲存鈕**（v0.24.1）。v0.24.0 的儲存鈕在整頁最下面，
     * 2026-09-19 使用者說調整完容易忘記按 —— 而忘了按是安靜的。這是最上面那一行的六種說法；
     * 「還沒動過」那一句在講這一頁的規則：第一次來的人要知道為什麼找不到儲存鈕。
     */
    autosave: {
      idle: '這一頁改了就會自動儲存：選了就存，文字欄在離開那一格時存。',
      saving: '儲存中…',
      saved: '已自動儲存（{time}）',
      editing: '有一格還在改，離開那一格（或按 Enter）就會儲存。',
      held: '金鑰變數的名字不合格（只能用大寫英文、數字與底線），改好之前這一頁不會儲存。',
      failed: '沒存成：{reason}',
      retry: '再存一次',
    },
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
