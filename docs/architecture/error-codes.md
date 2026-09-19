# 錯誤碼

**這份是每個錯誤碼的「成因」與「使用者該做什麼」的權威。**
錯誤在哪一行被丟出來不寫在這裡。

> **`src/domain/errors/` 才是碼本身的單一真實來源，這份是它的說明。**
> 一條 AST 測試比對兩邊 —— **任一邊多一個或少一個就紅**（REQ-0008）。
> 現況：`src/domain/errors/codes.ts` 與 `tests/guards/error-codes.test.ts` 都在，三邊對照（碼 ↔ 這一份 ↔ `i18n/zh-TW.ts`）。

---

## 三條規則

1. **UI 只顯示繁體中文訊息，錯誤碼只進日誌。**
   碼是給日誌與回報用的，不是給使用者讀的。
2. **每次操作帶 `correlation_id`，UI 上可以複製。**
   使用者回報問題時交出那一串，不用交出資料。
3. **兩欄都不得空白。** 一個沒有「使用者該做什麼」的錯誤碼，
   對使用者而言等於「壞了，自己想辦法」。

**未預期的例外也要有碼**（每組的 `*_UNEXPECTED`）與 `correlation_id`，
**不得出現英文 stack trace 直接噴到使用者畫面上**。

## 級別

| 級別 | 意思 | UI 行為 |
|---|---|---|
| `error` | 這件事做不成 | 顯示訊息 ＋ 可複製的 `correlation_id` |
| `partial` | **單項失敗，整批繼續** | 該項標失敗，run 進 `部分失敗`，其餘照常寫入 |
| `notice` | 不是失敗，但使用者需要知道 | 標記在該項目上（例如低信心） |

> **`partial` 是一等公民。** 一批 40 個 URL 有 3 個 404，其餘 37 個的內容不該跟著消失。
> 把它併進 `error` 是最容易犯、也最傷的簡化。

---

## `CASE_*` —— 專題

| 碼 | 級別 | 成因 | 使用者該做什麼 |
|---|:--:|---|---|
| `CASE_NOT_FOUND` | error | 專題資料夾或 `case.sqlite` 不在了（被手動搬走或刪除）。**2026-09-11 之前十幾支端點在這個情況下回的是 `IO_UNEXPECTED`（500）**，見 `tests/e2e/case-not-found.test.ts` | 回清單確認它還在不在；手動搬走的就把整個資料夾放回資料根的 `cases` 底下 —— `listCases` 掃的就是那一層。**原本這一格叫人按「開啟既有資料夾」，而那顆按鈕從來不存在** |
| `CASE_NAME_EMPTY` | error | 建立專題時名稱是空的 | 輸入一個名稱 |
| `CASE_NAME_DUPLICATE` | error | 同名專題已存在 | 換一個名稱，或開啟既有的那一個 |
| `CASE_FOLDER_EXISTS` | error | 要建（或改名成）的資料夾已經存在，**而裡面沒有 `case.sqlite`** —— **空資料夾也算**：Cyclosa 不往一個不是它建的資料夾裡寫東西，空的也一樣 | 換名稱；或到「設定 → 資料位置」找到資料根，用檔案總管處理 `cases` 底下那個資料夾。**2026-09-11 之前這一格叫人按「開啟既有資料夾」，而那顆按鈕（`POST /api/cases/open`）從來沒有被實作過** |
| `CASE_ARCHIVED` | error | 對已封存的專題做了需要它是使用中的操作 | 先重新開啟這個專題 |
| `CASE_RENAME_BLOCKED` | error | 改名時資料夾搬不動 —— 有東西正開著它（執行中的作業、檔案總管）| 讓作業跑完或關掉那個視窗，再試一次 |
| `CASE_NAME_MISMATCH` | error | 刪除時打的名稱跟專題名對不起來。**這不是驗證失敗，這是那道門本身** —— 比對在伺服器端，只在畫面上比是繞得過的 | 逐字打對專題名稱再試一次 |
| `CASE_STATUS_INVALID` | error | 現在的狀態做不了這個動作（最實際的是「作業還在跑的時候按封存」）。**與 `CASE_ARCHIVED` 分開，因為那個碼在這裡會說謊** —— 舊實作回「這個專題已封存」，而它明明沒有 | 訊息會說出該做什麼。作業在跑就先讓它跑完或取消 |
| `CASE_DELETE_BLOCKED` | error | 刪除時資料夾搬不進 `backups\` —— 有東西正開著它 | 讓作業跑完或關掉那個視窗，再試一次。**那個專題完整留著，沒有被刪掉一半** |
| `CASE_SCHEMA_TOO_NEW` | error | `case.sqlite` 的 schema 版本比這個程式新（被新版寫過）| 升級 Cyclosa。**不要用舊版繼續開**，會寫壞資料 |
| `CASE_SCHEMA_MIGRATE_FAILED` | error | migration 中途失敗 | 資料庫已經回復到 migration 前的狀態。把 `correlation_id` 交出來；`backups\` 裡有 migration 前的複本 |
| `CASE_UNEXPECTED` | error | 專題操作的未預期例外 | 把 `correlation_id` 交出來 |

## `IO_*` —— 檔案系統與資料根

| 碼 | 級別 | 成因 | 使用者該做什麼 |
|---|:--:|---|---|
| `IO_POINTER_MISSING` | error | `%LOCALAPPDATA%\Cyclosa\system_paths.json` 不存在（第一次啟動，或被刪掉）| 選一個資料根目錄，程式會把它記進指標檔 |
| `IO_POINTER_MALFORMED` | error | 指標檔存在但不是合法 JSON，或缺 `data_root` 欄 | 訊息裡有指標檔的完整路徑。刪掉它重新選一次，或手動修好 |
| `IO_DATA_ROOT_MISSING` | error | 指標檔指到的路徑不存在（外接硬碟沒插、資料夾被搬走）| 訊息會寫「指標檔在哪、它指到哪」。把那個路徑接回來，或重新選一個 |
| `IO_DATA_ROOT_NOT_WRITABLE` | error | 資料根存在但寫不進去（權限、唯讀磁碟）| 檢查那個資料夾的權限，或換一個位置 |
| `IO_DATA_ROOT_BUSY` | error | 有作業在跑的時候要搬資料根。搬家會把 `case.sqlite` 從一個正在寫它的行程底下抽走 | 等作業跑完或先取消它。`detail.activeRuns` 是還在跑的數量 |
| `IO_DATA_ROOT_TARGET_INVALID` | error | 要搬過去的位置不能用。`detail.reason`：`same`（就是現在這個）、`nested`（在現在這個底下，等於搬進自己）、`not-empty`（那裡已經有東西，蓋過去會毀掉它）| 換一個空的資料夾 |
| `IO_DATA_ROOT_MOVE_BLOCKED` | error | 資料根搬不動（有東西開著它），或跨磁碟區複製失敗 | **原本的資料完整留在原地，指標檔也沒有改。** 關掉開著那個資料夾的東西再試一次 |
| `IO_DISK_FULL` | error | 寫入時磁碟空間不足 | 清出空間再重試。**已經寫進去的東西不會壞** —— 交易沒有完成就不會留下半筆 |
| `IO_SNAPSHOT_MISSING` | partial | `item.sha256` 對應的快照檔不見了 | 那一項的閱讀器打不開。可以重新擷取（會產生新快照），**但原有的點註會標成「找不到原文位置」** |
| `IO_SNAPSHOT_CORRUPT` | error | 快照檔存在但雜湊對不上 —— **有人動過不可變的東西** | 這違反 ADR-0003。不要覆蓋它；把 `correlation_id` 交出來，並確認是不是同步軟體或防毒動過 `sources\` |
| `IO_UNEXPECTED` | error | 檔案系統的未預期例外 | 把 `correlation_id` 交出來 |
| `IO_SERVER_UNREACHABLE` | error | **只有前端會產生**：畫面連不到 Cyclosa 自己的伺服器（`fetch` 本身失敗）—— 按了「結束 Cyclosa」，或它自己停了。**沒有 `correlation_id`**（伺服器沒有回話）。v0.24.3 之前這個情況借用 `IO_UNEXPECTED` 的訊息，叫人交出一個不存在的識別碼 | 重新執行 `start_cyclosa.cmd`。如果是它自己停的，`%LOCALAPPDATA%\Cyclosa\logs\` 的 `server.log`（最後幾行）與 `server.err.log` 會說為什麼（`maintainer-notes.md` 有怎麼讀）|

## `FETCH_*` —— 擷取

| 碼 | 級別 | 成因 | 使用者該做什麼 |
|---|:--:|---|---|
| `FETCH_BAD_URL` | partial | 貼進來的不是一個 http／https 網址 | 檢查有沒有少了 `https://`、或貼到的是一段文字而不是網址。**`file:`／`javascript:` 不支援，而且是刻意的** |
| `FETCH_DUPLICATE` | notice | 這份內容已經在專題裡了（SHA-256 相同）| **什麼都沒有失敗。** 同一份東西不會建第二個節點 —— 這一列就是那條規則在運作的證據 |
| `FETCH_ROBOTS_DISALLOWED` | partial | 該網站的 `robots.txt` 不允許抓這個路徑 | **這一項不會被抓，而且不提供繞過。** 需要的話自己開瀏覽器讀，再用「貼上文字」匯入 |
| `FETCH_RATE_LIMITED` | partial | 對方回 429 或 503，**照 `Retry-After` 等過、再試兩次還是一樣**；或這個網域在這一輪已經被放棄（`detail.why` 是 `host-limited`，沒有送請求）| 過一段時間再重跑這幾項。**同一個網域排在後面的項目也記成這個碼，其他網域照常**（ADR-0031）|
| `FETCH_TIMEOUT` | partial | 連線或讀取逾時 | 重試那一項。反覆逾時通常是對方的問題 |
| `FETCH_DNS` | partial | 網域解析不到 | 檢查網址有沒有打錯、或網路是不是斷了 |
| `FETCH_TLS` | partial | 憑證驗證失敗 | **不提供忽略憑證的選項。** 那個網站的憑證有問題 |
| `FETCH_HTTP_4XX` | partial | 對方回 4xx（404、403…）| 404 通常是頁面沒了；403 常見於需要登入 —— 兩者都不會自動重試 |
| `FETCH_HTTP_5XX` | partial | 對方回 5xx | 稍後重試那一項 |
| `FETCH_TOO_LARGE` | partial | 回應超過單檔上限 | 那一項略過。真的需要就自己下載後用檔案匯入 |
| `FETCH_UNSUPPORTED_TYPE` | partial | content-type 不在支援清單裡 | 第一版支援網頁／Markdown／純文字／PDF／圖片。**不支援的會列出來，不是靜默略過** |
| `FETCH_LOGIN_REQUIRED` | partial | 偵測到需要登入或付費牆 | **不繞過付費牆、登入或存取控制**（不可違反的規則之一）。自己登入後另存再匯入 |
| `FETCH_BOT_CHALLENGE` | partial | 回來的是反爬蟲驗證頁，不是內容（`domain/ingest/challenge.ts` 三層，多半是 **HTTP 200**）| **不繞過**。跟上一條分開是因為建議不同 —— 登入沒有用，要自己用瀏覽器打開再匯入。`detail.certain` 分得開「認得這個產品」與「這一頁看起來不像內容」 |
| `FETCH_UNEXPECTED` | partial | 擷取的未預期例外 | 把 `correlation_id` 交出來 |

## `PARSE_*` —— 抽取

| 碼 | 級別 | 成因 | 使用者該做什麼 |
|---|:--:|---|---|
| `PARSE_EMPTY_CONTENT` | partial | 抽不到任何正文 | 看「原始快照」確認那一頁本來就有沒有內容 |
| `PARSE_JS_ONLY` | partial | 靜態 HTML 沒有內容，正文由 JS 產生 | **明確標示，不會交出一份空正文假裝那頁本來就沒東西。** 第一版不裝 Playwright（REQ-0003）|
| `PARSE_LOW_CONFIDENCE` | **notice** | 抽取信心低（版面複雜、正文比例異常）| **不是失敗。** 那一項在清單與閱讀器裡會有標記 —— 引用它之前對一下原始快照 |
| `PARSE_PDF_NO_TEXT_LAYER` | **notice** | 掃描的 PDF，沒有文字層 | 這一份只能框選區域做註記，不能選文字（ADR-0019）。**不是工具壞了** |
| `PARSE_PDF_ENCRYPTED` | partial | PDF 有密碼或限制擷取 | 第一版不處理加密 PDF。自己解密後再匯入 |
| `PARSE_IMAGE_UNSUPPORTED` | partial | 圖片格式無法解碼 | 轉成常見格式（PNG／JPEG／WebP）再匯入 |
| `PARSE_ENCODING` | partial | 文字編碼判不出來或解碼失敗 | 那一項的正文可能有亂碼。用「原始快照」對照 |
| `PARSE_UNEXPECTED` | partial | 抽取的未預期例外 | 把 `correlation_id` 交出來 |

## `PROVIDER_*` —— LLM 與嵌入

| 碼 | 級別 | 成因 | 使用者該做什麼 |
|---|:--:|---|---|
| `PROVIDER_NOT_CONFIGURED` | error | 這個角色（`agent`／`chat`／`embed`）沒有設定任何 provider | 到設定頁指定一個 |
| `PROVIDER_CAPABILITY_MISSING` | error | **這個任務需要某個能力，而目前的 provider 沒有** | 訊息會寫「需要什麼、目前的有什麼」。換一個 provider，或改用不需要那個能力的做法。**工具不會自動換一個能力較弱的**（ADR-0006）|
| `PROVIDER_UNREACHABLE` | error | 子程序起不來，或 HTTP 端點連不上 | `claude` 不在 PATH 上？Ollama 沒開？訊息會說是哪一種 |
| `PROVIDER_TIMEOUT` | partial | 單次請求或整個 run 逾時 | **已經寫進去的節點與關聯保留。** 可以再跑一次補剩下的 |
| `PROVIDER_BUDGET_EXCEEDED` | partial | 超過這次 run 的請求數或成本上限 | **已寫入的保留。** 要繼續就調高上限再跑一次 |
| `PROVIDER_OUTPUT_UNPARSEABLE` | partial | 模型的輸出解析不出來（不是預期的結構）| 那一項略過，其餘照常。反覆發生通常代表這個模型不適合這個任務 |
| `PROVIDER_QUOTE_NOT_FOUND` | partial | **模型給的引文在原文裡找不到**| 那幾條關聯不寫進去，其餘照常。這不是「解析不出來」—— 那份輸出解析得很成功，它只是在講一句原文沒有講過的話。**一個指不到原文的出處比沒有出處更糟**，因為它看起來已經被驗過了 |
| `PROVIDER_SANDBOX_VIOLATION` | error | **`agent` 的沙箱目錄裡出現了抓取產物** | 這違反「agent 找到的東西不能自己抓」。run 會停下來。把 `correlation_id` 交出來 |
| `PROVIDER_EMBED_MODEL_MISMATCH` | error | **要比對的向量是另一個嵌入模型產的** | 換回原本的模型，或重算整個專題的向量。**工具不會拿兩個模型的向量硬比** —— 那會回一個看起來正常的錯答案 |
| `PROVIDER_AUTH_REJECTED` | error | **端點回了話，但拒絕了金鑰**（HTTP 401／403）| 看設定頁那個環境變數是不是設了、值對不對。**不是「連不上」** —— 它明明開著、而且回了話 |
| `PROVIDER_RATE_LIMITED` | error | 端點說請求太多（HTTP 429），**照 `Retry-After` 等過、再試兩次還是 429** | 等一下再跑。退避照官方 SDK 的慣例（0.5 秒起跳、最多兩次），不是這個工具自己發明的規矩（ADR-0031）|
| `PROVIDER_JSON_UNSUPPORTED` | error | **這個模型在這個端點上連「回一份 JSON」都不保證**：`json_schema` 與 `json_object` 兩種都量過而且都不成立。**最常見的原因是選到了不能對話的模型** —— OpenAI 相容端點的 `/models` 會把嵌入模型一起列出來 | 換一個端點或模型。**這一條是停手不是降級** —— 從散文裡撈 JSON 會在模型換一種寫法時安靜地少撈幾條 |
| `PROVIDER_OUTPUT_SCHEMA_MISMATCH` | partial | 回了一份 JSON，**但形狀不符合這個任務的 schema**。只在端點不保證 schema、由工具事後驗證時出現| 那一項略過，其餘照常。**形狀不對的一律擋下來** —— 那是抽取時防提示詞注入的第二層，端點不做的時候由工具做 |
| `PROVIDER_UNEXPECTED` | error | provider 的未預期例外 | 把 `correlation_id` 交出來 |

## `RUN_*` —— 作業本身

| 碼 | 級別 | 成因 | 使用者該做什麼 |
|---|:--:|---|---|
| `RUN_NOT_FOUND` | error | 找不到那次作業 | 確認是不是在另一個專題底下 |
| `RUN_STILL_ACTIVE` | error | 想復原一次**還在跑的**作業 | **先取消，或等它跑完** —— 一邊寫一邊刪會留下說不清楚的狀態 |
| `RUN_UNEXPECTED` | error | 作業處理的未預期例外 | 把 `correlation_id` 交出來 |

## `GRAPH_*` —— 圖與裁決

| 碼 | 級別 | 成因 | 使用者該做什麼 |
|---|:--:|---|---|
| `GRAPH_EVIDENCE_REQUIRED` | error | 要把一條機器產生的邊標成「已確認」，但它沒有任何引文 | 先補一筆出處，或改成手動建立一條 `origin='human'` 的邊 |
| `GRAPH_HUMAN_ROW_IMMUTABLE` | error | **有東西試圖修改 `origin='human'` 的列** | 這是程式的 bug，不是使用者的操作問題。把 `correlation_id` 交出來 |
| `GRAPH_TOMBSTONED` | **notice** | 機器想提出一條被否決過的關聯 | **它不會進佇列。** 若它帶著新出處，會以「曾被否決」的標記進待查證（ADR-0016）|
| `GRAPH_TRANSITION_INVALID` | error | 不在轉移表上的狀態變更 | 程式的 bug。把 `correlation_id` 交出來 |
| `GRAPH_LAYER_NOT_ADJUDICABLE` | error | 想裁決一條**下次重算就會被蓋掉**的邊（機器建的共同提及／相似度／衍生）| 那三層是**算出來的結果，不是主張**，所以它們不進裁決佇列（ADR-0015）。要記錄一個判斷就手動建一條具名關係 |
| `GRAPH_NODE_NOT_FOUND` | error | 焦點節點不存在（被刪掉了）| 回專題清單重新進來 |
| `GRAPH_EDGE_NOT_FOUND` | error | 要裁決或查看的關聯不存在 | 重新整理這一屏。**投影出來的線（`proj:` 開頭）本來就不是資料庫裡的一列**，它沒有東西可以裁決 |
| `GRAPH_EDGE_EXISTS` | error | 手動建立的關聯，這個（來源, 目標, 關係型別）已經有了 | 去改既有的那一條，不要建第二條。**同一個主張存兩列會讓獨立來源數重複計算** |
| `GRAPH_AUDIT_APPEND_ONLY` | error | **有東西試圖改或刪 `edge_audit` 的列** | 這是程式的 bug。稽核紀錄只增不刪，因為校準比例是從它算出來的。把 `correlation_id` 交出來 |
| `GRAPH_REL_EMPTY` | error | 手動建立具名關係時沒有寫關係型別 | 寫一個動詞或名詞（「收購」「任職於」）。**一條沒有名字的具名關係不是主張**，日後也篩不出來 |
| `GRAPH_SELF_EDGE` | error | 想把一個節點連到它自己 | 選兩個不同的節點 |
| `GRAPH_SUBGRAPH_TOO_LARGE` | error | 子圖查詢的結果超過渲染上限 | **「這個範圍太大，請縮小 hops 或加篩選」。** 工具列的跳數格會顯示每一格會帶進幾個節點 |
| `GRAPH_SUBGRAPH_TIMEOUT` | error | 子圖查詢逾時 | 縮小 hops 或加篩選。反覆發生代表索引有問題 |
| `GRAPH_UNEXPECTED` | error | 圖操作的未預期例外 | 把 `correlation_id` 交出來 |

## `NOTE_*` —— 筆記與點註

| 碼 | 級別 | 成因 | 使用者該做什麼 |
|---|:--:|---|---|
| `NOTE_ANCHOR_UNRESOLVED` | **notice** | 錨點在快照裡找不到對應位置 | **註記內容保留，不會被丟掉，也不會錨到錯的地方。** 顯示「找不到原文位置」，可以手動重新指定 |
| `NOTE_TARGET_MISSING` | error | 點註指向的 `item` 不在了 | 那份資料被刪掉了。註記本身還在 `notes\*.md` |
| `NOTE_MD_WRITE_FAILED` | partial | `notes\*.md` 寫不進去 | **註記已經進資料庫了**，只是純 Markdown 那一份沒寫成。檢查資料根的權限 |
| `NOTE_UNEXPECTED` | error | 點註的未預期例外 | 把 `correlation_id` 交出來 |

## `SEARCH_*` —— 檢索

| 碼 | 級別 | 成因 | 使用者該做什麼 |
|---|:--:|---|---|
| `SEARCH_QUERY_EMPTY` | error | 查詢字串是空的 | 輸入要找的東西 |
| `SEARCH_INDEX_INCOMPLETE` | **notice** | 有些項目還沒建好索引（匯入還在跑）| **結果可能不完整**，畫面會標出來。等匯入跑完再查一次 |
| `SEARCH_EMBED_UNAVAILABLE` | **notice** | 語意檢索用的 provider 不可用 | **全文檢索照常運作**（那是純 SQLite，不需要模型）。語意那半會標示不可用 |
| `SEARCH_UNEXPECTED` | error | 檢索的未預期例外 | 把 `correlation_id` 交出來 |

## `EXPORT_*` —— 證據包匯出

| 碼 | 級別 | 成因 | 使用者該做什麼 |
|---|:--:|---|---|
| `EXPORT_EMPTY_SELECTION` | error | 沒有選任何節點就按匯出 | 先在圖上框選一塊 |
| `EXPORT_TARGET_NOT_WRITABLE` | error | 匯出目的地寫不進去 | 換一個資料夾 |
| `EXPORT_EVIDENCE_MISSING` | **notice** | 選取範圍裡有邊的引文回溯不到 `item` | **那幾條會在匯出的檔案裡標明**，不會靜默省略 |
| `EXPORT_UNEXPECTED` | error | 匯出的未預期例外 | 把 `correlation_id` 交出來 |

---

## 診斷匯出

REQ-0008 要求「能把診斷資訊交出去，而不用連自己的資料一起交出去」。

**診斷匯出去識別化**：不含使用者名、機器名、絕對路徑，
也不含任何來源內容或筆記內容。**匯出後可以先人工檢視再送出。**

裡面有什麼：`correlation_id`、錯誤碼、時間、發生階段、
以及**經過去識別化的**計數（幾項成功／幾項失敗／哪些錯誤碼各幾次）。

**任何東西都不往外送**（REQ-0008 的「刻意不做」）—— 匯出是產生一個檔案，
交不交出去是使用者的決定。
