# API 合約

**這份是端點、請求／回應形狀與錯誤對映的權威。**
業務規則在 `domain/`（見 `overview.md` 的分層），錯誤碼的意義在 `error-codes.md`。

> **現況（2026-09-07）：一部分實作了。**
>
> **已經存在**：系統（`/healthz`、資料根）、專題（清單／建立／封存）、
> **匯入**（`/import/urls`、`/import/file`）、**作業紀錄**（`/runs`、`/runs/:id`、
> **SSE `/runs/:id/events`**、`/cancel`）、**資料節點與閱讀器**
> （`/items`、`/items/:id`、`/content`、`/snapshot`、`/read`、`/exclude`、
> `/restore`、`/retry`）。
>
> **v0.3.0 新增**：`/subgraph`、`/subgraph/size`、**`/subgraph/focus`**。
>
> **v0.4.0 新增**：`/edges/:edgeId`、`POST /edges`、`/edges/:edgeId/transition`、`/queue`。
>
> **v0.5.0 新增**：`GET`／`POST /api/providers`、`/api/providers/test`、
> **`POST …/runs`** 與 **`POST …/runs/:runId/angles`**（擴展的兩階段）。
>
> **v0.6.0 新增**：`POST`／`GET …/items/:itemId/notes`、`GET …/notes`、
> `PATCH`／`DELETE …/notes/:noteId`、**`POST …/rebuild`**（`derived/` 整批重算）。
>
> **v0.7.0 新增**：`GET`／`POST /api/sources`、`DELETE /api/sources/:host`、
> `POST /api/sources/check`；`GET …/entities/merges`、`POST …/entities/merge`、
> `POST …/entities/:entityId/unmerge`。
>
> **v0.8.0 新增**：**`POST …/export/evidence`**（證據包匯出）。
>
> **2026-09-08 補**：`POST …/cases/:id/rename`、
> **`POST …/runs/:runId/pause`／`/resume`／`/undo`**、**`POST /api/system/shutdown`**。
>
> **v0.11.0 新增**：**`GET …/search`**（全文／語意／兩者）與
> **`POST …/embed`**（補一批向量）。
>
> **v0.12.0 沒有新端點** —— 它是規模驗收。`/subgraph/size` 的回應多一個
> `capped` 欄位（ADR-0029），其餘不變。
>
> **v0.18.0 也沒有新端點**（2026-09-11）。`GET /api/providers` 多回 `embedModels`
> 與兩個 `jsonMode`，`POST /api/providers/test` 多回一個 `jsonMode`，
> 設定檔的 `chat` 多一欄 `transport`。**新的四個錯誤碼**（`PROVIDER_AUTH_REJECTED`、
> `PROVIDER_RATE_LIMITED`、`PROVIDER_JSON_UNSUPPORTED`、`PROVIDER_OUTPUT_SCHEMA_MISMATCH`）
> 見 `error-codes.md`。前三個是 `error`（HTTP 409，跟既有的 `PROVIDER_*` 一致），
> 最後一個是 `partial`（一項抽壞了不讓整批失敗）。
>
> **v0.13.0 也沒有新端點** —— `GET /api/providers` 的回應把 `chatReadiness`
> 換成涵蓋四個任務的 `taskReadiness`，`config.agent` 多一個 `model`。
>
> **路徑用專題的 slug 當 `:id`** —— 一個專題就是一個資料夾，而資料夾名就是 slug。

---

## 三條規則

1. **`interface/http/` 的 route 只做三件事**：解析請求 → 呼叫 application 的 service
   → 把 `Result` 對映成 HTTP。**業務規則不寫在 route handler 裡。**
2. **每個回應都是同一個信封**，成功與失敗都是。
3. **沒有 `GET /graph`。** 不是「有但不建議用」，是**不存在**（ADR-0008）。

## 回應信封

```jsonc
// 成功
{ "ok": true,  "data": { … }, "correlationId": "01J…" }
// 失敗
{ "ok": false, "code": "FETCH_ROBOTS_DISALLOWED", "message": "繁體中文訊息",
  "correlationId": "01J…", "detail": { … } }
```

**`code` 只進日誌與診斷匯出，`message` 才是給人看的**（REQ-0008）。
`correlationId` 在 UI 上可以複製。

**HTTP 狀態碼與 `code` 的對映**：

| `code` 開頭或性質 | HTTP |
|---|---|
| 找不到（`*_NOT_FOUND`、`CASE_NOT_FOUND`）| 404 |
| **請求本身不合法**（`*_EMPTY`、`GRAPH_SELF_EDGE`）| 400 |
| **跟既有狀態衝突**（`*_DUPLICATE`、`CASE_FOLDER_EXISTS`、`CASE_ARCHIVED`、`GRAPH_EVIDENCE_REQUIRED`、`PROVIDER_*`）| 409 |
| 超過界線（`GRAPH_SUBGRAPH_TOO_LARGE`、`FETCH_TOO_LARGE`）| 413 |
| 逾時（`*_TIMEOUT`）| 504 |
| 其餘 `*_UNEXPECTED`、`IO_*` | 500 |

> **`partial` 級別的碼不會變成 HTTP 錯誤。** 它們發生在 run 的個別項目上，
> 整批請求本身是 `200 ok:true`，而失敗的那幾項在 run 的項目清單裡各自帶著自己的碼。
> **這是「部分失敗是一等公民」在 API 層的樣子。**

---

## 子圖 API —— 這一份的核心

### `GET /api/cases/:caseId/subgraph`

| 參數 | 說明 |
|---|---|
| `focus` | 從哪個節點出發。**必填** |
| `hops` | 幾層。預設 `2`，上限 `3` |
| `types` | 節點型別篩選（`item`／`entity` 的子型別）|
| `layers` | 關聯層篩選（`derived`／`named`／`comention`／`similarity`）|
| `status` | 查證狀態篩選。**預設排除 `已否決`** |
| `minConfidence` | 可信度下限（`weak`／`medium`／`strong`）|
| `since` / `until` | 時間範圍 |
| `projection` | 實體投影門檻（**展開成節點需要幾篇**），預設 `3`（見 `data-model.md` 的三段）|

> **只有「展開成節點」那一個門檻可以調，「畫不畫」那一個沒有暴露出來。**
> 不是漏掉的：一個只被 1 份文件提到的實體，攤平出來是 *n(n−1)/2* = **0 條線** ——
> 它畫成「線」跟畫成「純屬性」在畫面上一模一樣。
> **給一個改了什麼都不會變的旋鈕，比不給更糟。**

**不合法的參數一律丟掉，不回 400** —— 這兩支在工具列上每動一下就跑一次，
而一個 400 會讓整張圖消失。跳數超過上限是**夾到上限**，不是錯誤。

回傳節點與邊，**外加每條 `named` 邊的可信度等級與獨立來源數** ——
否則側欄為了顯示一行「出處 5 筆 · 2 個獨立來源」要再打一次 API。

**超過渲染上限時回 `GRAPH_SUBGRAPH_TOO_LARGE`（413），不是回一個巨大的結果。**

**預算與硬上限是兩個不同的數字，這是刻意的**：
`2,000` 是預算（REQ-0005 驗收過互動 fps 的規模，超過只標琥珀、仍然按得下去），
`8,000` 才是拒絕的那一條 —— **而 8,000 就是 ADR-0007「換掉 `3d-force-graph`」的觸發條件**。
兩者相同的話，琥珀色警示就無事可警了。

> **回傳的邊裡有一種在資料庫裡不存在**：實體低於展開門檻時攤平出來的
> 共同提及線。它們的 `id` 帶 `proj:` 前綴、`synthetic: true`、`via` 指著被攤平的那個實體。
> **不可以拿它們去做任何寫入** —— 那一列不存在。

### `GET /api/cases/:caseId/subgraph/focus`

**`focus` 是必填的，而打開分頁的時候前端沒有東西可以給它。**
所以有這一支：**它回一個起點，不回一張圖。**

```jsonc
{ "ok": true, "data": { "focus": "01J…", "totalNodeCount": 312 } }
```

回的是**連得最多的那一個節點**，不是最近匯入的那一個。
那是 v0.3.0 第一次人工驗收改掉的：最後匯入的那一份剛好一條關聯都沒有，
於是打開專題看到的是畫面正中央一個孤零零的點 —— 技術上完全正確，
**但它讓人以為圖壞了**。專題是空的就回 `focus: null`，畫面顯示空狀態。

### `GET /api/cases/:caseId/subgraph/size`

**同樣的參數，只回數量，不回內容。**

```jsonc
{ "ok": true, "data": { "counts": { "1": 12, "2": 143, "3": 1806 },
                        "budget": 2000, "overBudget": ["3"], "capped": [] } }
```

工具列的跳數格用它**即時顯示每一格會帶進來幾個節點**，超過預算的那一格標琥珀色
（ADR-0018 的 D 層顏色只在面板，這裡是面板）。

> **欄位名 2026-09-10 更正**：這裡原本寫的是 `hops`，而出貨的一直是 `counts`。

**`capped` 裡的那幾格，數字是下界不是實際值**（ADR-0029）。
走訪走到硬上限（8,000）就停了，所以畫面上要顯示 `16272+` 而不是 `16272`。

> **為什麼不數完。** 5 萬筆／20 萬關聯的實測（`../environment/performance.md`）：
> 從一個**中位數度數（3）**的節點走 3 跳會走到 **32,170 個節點**，
> 而超過 8,000 的子圖一律回 413 —— **「32,170」與「超過 8,000」
> 對使用者是同一句話**，而後者便宜十四倍。

> **為什麼要有這個端點。** 「2 跳」是預設值，不是研究結論 ——
> 有依據的是「要有上限」這件事。節點數大約以分支度的跳數次方成長：
>
> | 分支度 | 1 跳 | 2 跳 | 3 跳 | 4 跳 |
> |---|---|---|---|---|
> | 3 | 4 | 13 | 40 | 121 |
> | 6 | 7 | 43 | 259 | 1,555 |
> | 10 | 11 | 111 | 1,111 | 11,111 |
>
> 把「跳數」變成「節點預算」，那個常數就不再是拍出來的。
> **這支查詢只數不拉資料，效能預算 < 50 ms** ——
> **而 2026-09-10 量出來是 283–937 ms，沒有過**（ADR-0029）。
> 從 4,566 ms 降到那裡靠的是上界 ＋ 跳內分段；剩下的差距在
> `traverse` 與 `mentionCounts` 自己身上，要改資料結構才動得了。

### 需要「全貌」的時候

**伺服器端算完只傳結果**（統計、社群、時間軸），不是把圖傳給前端讓它自己算。
除錯時要 dump 整張圖走 `tools/` 的診斷匯出，**直接讀 SQLite** —— 不是打一個 API。

---

## 其餘端點

**分頁一律用 cursor**（不是 offset）。5 萬筆規模下 `OFFSET 40000` 會逐列掃過去。

### 系統

| 端點 | 說明 |
|---|---|
| `GET /healthz` | 回 `{"app":"cyclosa","version":"…"}`。**單一實例偵測靠它**（ADR-0020）—— 只看有沒有回 200 會把別人的服務誤認成自己 |
| `GET /api/providers` | 各角色目前設定了什麼、能力宣告是什麼、**跑不跑得動它要跑的任務（缺哪幾樣）**。另外回兩份模型清單：`chatModels`（**照 `chat` 的傳輸去問**：Ollama 問 `/api/tags`、OpenAI 相容端點問 `/models`）與 `embedModels`（**永遠問嵌入自己那個本機位址**）—— **`null` 代表列不出來**，不是「一個都沒有」。`chat` 的狀態多帶 `transport` 與 `jsonMode`（「符合 schema」由誰保證、什麼時候量的，ADR-0030），`chatTasks` 每一列也各帶一個 `jsonMode`。**這一支不送任何一次對話請求** —— 格式量測只讀已經記下的結果 |
| `POST /api/providers` | 存設定。設定檔在 `%LOCALAPPDATA%\Cyclosa\providers.json`，**不在資料根裡**（storage-layout）。`chat.transport` 是 `ollama`／`openai`，**缺或不認得就是 `ollama`**（v0.18.0 之前唯一的選項）|
| `POST /api/providers/test` | `{role}`：**實際打一次**。回 `{ok, code, costUsd, elapsedMs, jsonMode}`。**`chat` 走 OpenAI 相容端點時，這一次會先重量格式支援**並記進 `provider-checks.json` —— 所以這顆按鈕同時是「重新檢查」，也因此會多花一到兩次很小的請求 |
| `GET /api/system/fetch-policy` | 對外抓取的規矩：同網域間隔（以及它是預設值還是環境變數給的）、下限、限流時最多再試幾次、預設退避、`Retry-After` 上限。**作業紀錄頁那一列從這裡讀數字**，不寫死在 i18n 裡（ADR-0031）|
| `GET /api/system/data-root` | 現在的資料根與指標檔位置。**指標檔不存在時會自動建一個預設的**（見下）|
| `POST /api/system/data-root` | 指一個資料根（**還沒有的時候**）。只寫指標檔，不搬東西 |
| `POST /api/system/data-root/move` | 換一個資料根，**既有的東西跟著搬過去**|
| `POST /api/system/sample` | 重建範例專案。已經有一份時回 `CASE_NAME_DUPLICATE` —— **重建不該悄悄產生第二份** |

> ### 第一次啟動不問任何問題
>
> `GET /api/system/data-root` 在**指標檔不存在**時自動建
> `%LOCALAPPDATA%\Cyclosa\data` 並寫指標檔 —— 前端每次進清單頁第一個打的就是它。
>
> **只有「指標檔不存在」走自動建立。** 另外三種失敗
> （`IO_POINTER_MALFORMED`、`IO_DATA_ROOT_MISSING`、`IO_DATA_ROOT_NOT_WRITABLE`）
> 一律照原樣回，因為**它們後面可能有一整份資料**：
> 指標檔指到 `E:\…` 而隨身碟沒插的時候自動頂替一個空資料夾，
> 使用者會看到一個乾淨的空清單、一個字都沒說。
> 那正是 REQ-0001 花四個錯誤碼在擋的事。
>
> **自動建立的同時會放一份範例專案**。它只發生在這一條路上，
> 所以「使用者刪過了」不需要另外記旗標 ——
> **「資料根存不存在」已經是那個旗標**。做法與理由在 `sample-service.ts`。
>
> `move` 的守門：有作業在跑（`IO_DATA_ROOT_BUSY`）、目標不能用
> （`IO_DATA_ROOT_TARGET_INVALID`，`detail.reason` 是
> `same`／`nested`／`not-empty`）。**搬完才寫指標檔** ——
> 失敗時舊的地方原封不動，指標檔也還指著它。
> 唯一的例外在跨磁碟區（複製再刪）：**複製完成之後**刪舊的途中失敗，舊的已經少了一部分，
> 所以照常指到新位置、殘骸留在舊位置 —— 不會回頭刪掉唯一完整的那一份。

> **`GET` 與 `test` 是兩件事，而且分開得很刻意。**
> 打開設定頁**不該產生費用** —— 所以 `GET` 對 `agent` 只跑 `--version`、
> 對 `chat` 只讀 `/api/tags`（本機、免費）。
> `test` 是使用者按的按鈕，**而畫面上那個按鈕旁邊要先講它會不會花錢**。
>
> `costUsd` 的 **`null` 與 `0` 是兩件事**：本機模型的金額成本真的是零；
> 一個沒回報成本的 provider 是「不知道」。**不估算**（ADR-0006 的補記）。

> ### 檢索與向量（2026-09-10，v0.11.0）
>
> `GET /api/cases/:slug/search` 的 `mode` 三個值都真的做事了：
>
> | `mode` | 跑哪幾路 |
> |---|---|
> | `text`（預設）| bigram ＋ FTS5。**完全不碰嵌入端點** |
> | `semantic` | **只有**向量 —— 混進字面命中的話它就跟 `hybrid` 沒有差別 |
> | `hybrid` | 三條都跑 |
>
> 合併發生在**名次**上（ADR-0027）。要求語意但拿不到向量時
> （沒設模型、Ollama 沒開、模型被 `ollama rm` 掉），
> **全文照常回，`notices` 帶 `SEARCH_EMBED_UNAVAILABLE`** ——
> 降級可以，安靜不行。
>
> `hit.check` 多一個值 **`semantic`**：語意那一路命中的文件本來就不會有那串字，
> 標成 `miss` 等於對一個正確的結果指控它是誤中。它的 `snippet` 是
> **真正命中的那一段**，而不是命中處前後 96 個字（語意命中沒有「命中處」）。
>
> `POST /api/cases/:slug/embed` 補一批向量，回
> `{model, processed, written, remaining, rows, owners, otherModels, code}`。
> **一次一批**（60 份），呼叫端看 `remaining` 決定要不要再打一次 ——
> 而**呼叫端要自己收斂**：`remaining` 沒有變少就停，不要等對方回 0。
>
> **它不是 `run`**：續跑點就是「還有哪些沒有向量」這個查詢本身，
> 所以取消與復原對它沒有意義，而一個假的取消按鈕比沒有更糟。
> `model` 是 `null` 代表還沒設定嵌入模型 —— **那是一個狀態，不是錯誤。**

> ### `chat` 的逐任務覆寫（2026-09-10，v0.10.6）
>
> `chat` 底下有兩個任務，而量測顯示它們的最好解不是同一個模型
> （`research/chat-choice.md` 發現六）。所以設定裡多一欄
> `chat.taskModels`：**每個任務一個鍵，空字串 ＝ 跟著 `chat.model`。**
> 覆寫的只有模型 —— `baseUrl` 與 `apiKeyEnv` 刻意不能逐任務分岔，
> 否則「本機模型不花錢」這件事會變成按任務而異。
>
> `GET /api/providers` 因此多回兩個陣列，而**它們回答的是不同的問題**：
>
> | 欄位 | 回答什麼 |
> |---|---|
> | `chatTasks` | 每個 chat 任務**實際會跑在哪個模型上**，那個模型的 `state` 與能力宣告 |
> | `taskReadiness` | **四個任務**各自跑不跑得動（`{task, role, model, overridden, ok, missing}`）|
>
> **角色層的 `readiness` 是 `taskReadiness` 的合併結果，不是自己算的。**
> 自己算的話它算的是預設模型 —— 而覆寫之後那已經不是實際會跑的東西，
> 於是畫面會出現「角色是綠的、按下擴展卻停手」。
>
> 舊的設定檔沒有 `taskModels` 這一欄，**缺就是全部沒覆寫**（不是壞掉）。
> 不認得的任務名在讀進來的時候就丟掉：留著的話它在檔案裡看起來像是設過了。

> ### 2026-09-10（v0.13.0）：任務表從 chat 底下的兩個擴成跨角色的四個
>
> `taskReadiness`（**原本叫 `chatReadiness`**）現在涵蓋 `MODEL_TASKS` 的四項：
> `find-sources`（agent）、`angles`／`extract`（chat）、`embed`（embed）。
>
> 改的理由是使用者問的那句話：**「我能不能替每一件事各挑一個模型」** ——
> 而那需要一份完整清單。逐任務覆寫原本放在 `chat` 那一區底下，
> 於是「找來源」與「嵌入」永遠不會出現在它旁邊。
>
> 跟著改的兩件：
>
> - **`agent` 多一個 `model`**，走 CLI 的 `--model`。
>   **空字串 ＝ 不帶這個旗標**，用 CLI 自己的預設 —— 那是一個有效的選擇，
>   不是沒設定。舊設定檔缺這一欄讀出來就是空字串。
> - **沒設定的角色不再宣稱缺什麼。** 一個完全沒設定的角色能力宣告當然全空，
>   所以配對一定回「缺 X」—— 而畫面上那句是「這個角色要跑的任務需要 X，
>   **而目前設定的模型沒有**」。那句話對它是錯的：問題不是模型不夠好，是還沒選。

### 專題

| 端點 | 說明 |
|---|---|
| `GET /api/cases` | 清單 ＋ 每個專題的統計（節點數、實體數、關聯數、**待查證幾條**、最後擴展時間）|
| `POST /api/cases` | 建立。三次點擊以內完成的那一步 |
| `POST /api/cases/:slug/status` | `{action: 'archive' \| 'reopen'}`。封存與重新開啟 |
| `POST /api/cases/:slug/rename` | 改名。**名稱與資料夾一起改**，回的是**新的** `CaseSummary`（`slug` 已經是新的）|
| `POST /api/cases/:slug/delete` | 刪除。**兩段式**，見下面那一節 |

> **2026-09-11 更正兩處。** 這張表原本寫著
> `POST /api/cases/:id/archive ／ /reopen`（實作一直是一支 `/status` 帶 `action`），
> 以及 `POST /api/cases/open`（開啟既有資料夾）—— **後者從來沒有被實作過。**
>
> 前者是形狀漂了，後者是**一份用權威語氣描述了不存在世界的文件**，
> 而那正是 ADR-0001 寫下來要防的東西。
> 兩個都是 v0.17.0 把封存接上按鈕時才撞到的。
>
> 「開啟既有資料夾」目前唯一的做法是**把資料夾放進資料根的 `cases\` 底下**，
> 下一次列清單就會看到它（`listCases` 掃的就是那一層）。
> `CASE_FOLDER_EXISTS` 與 `CASE_NOT_FOUND` 的訊息原本都叫人去按那顆不存在的按鈕 ——
> **2026-09-11 兩條都改掉了**，另外刪掉一個沒有任何元件用到的 `openExisting` 標籤
> （一個等著被接成「點了沒反應的按鈕」的字串）。

### 資料節點

| 端點 | 說明 |
|---|---|
| `GET /api/cases/:id/items` | cursor 分頁 ＋ 篩選 |
| `GET /api/cases/:id/items/:itemId` | 含抽取信心、來源 URL、語言 |
| `GET …/items/:itemId/content` | **重構後的正文**（`derived/`）|
| `GET …/items/:itemId/snapshot` | **原始快照位元組**（`sources/`，不可變）|
| `GET …/subgraph/focus` | 打開關聯圖時的起點。**回一個焦點，不回一張圖** |
| `POST …/items/:itemId/read` | 標記已讀。**正交旗標，不是狀態轉移** |
| `POST …/items/:itemId/exclude` ／ `/restore` | 已排除／復原。**只有人能做** |
| `POST …/items/:itemId/retry` | 重試失敗的項目。**不產生第二個節點** |

### 關聯與裁決

| 端點 | 說明 |
|---|---|
| `GET …/edges/:edgeId` | 含引文、獨立來源數、可信度等級與構成事實、校準比例、裁決歷史 |
| `POST …/edges` | **手動建立。一建立就是 `已確認` ＋ `origin='human'`** |
| `POST …/edges/:edgeId/transition` | `{action}`：`confirm`／`reject`／`withdraw`／`reclassify`／`restore`。**六條轉移都走這一個端點**，不在轉移表上的組合回 `GRAPH_TRANSITION_INVALID` |
| `GET …/queue` | 裁決佇列。**只有 `layer='named'` 的邊會出現在這裡** |

> **五個動詞，六條轉移** —— `reclassify` 是雙向的（已確認→已否決、已否決→已確認），
> 從哪一邊出發由目前的狀態決定。2026-09-06 寫這張表時漏了它，
> 而那一格旁邊就寫著「六條轉移都走這一個端點」——
> **一張自己跟自己矛盾的表**，2026-09-08 動手接端點時才發現。

> **沒有「機器提出一條邊」的端點，而那是刻意的。**
> 那條路只有擴展作業走得到，而擴展是從 `POST …/runs` 進來的。
> 開一個公開的寫入端點，等於給了一條**繞過墓碑檢查與出處要求**的路。

**`GET …/edges/:edgeId` 回的東西裡有一個 `fields`**，說明這條邊的面板上
哪幾欄有意義（狀態／可信度／構成事實／裁決）。
理由是有些欄位在某些列上**永遠是同一個值** —— `status` 對機器建的非 `named` 邊
永遠是 `pending`，`confidence` 對人建的邊永遠是 1（那個 1 是為了線寬，不是量出來的）。
**顯示一個結構性的值，會讓它看起來像測量結果。**
規則在 `domain/graph/render-rules.ts`，不在元件裡。

### 擴展作業

| 端點 | 說明 |
|---|---|
| `POST …/runs` | `{topic}`。開一次 run，回傳的是**多視角子問題清單**，還沒開始抓。run 停在 `排隊` |
| `POST …/runs/:runId/angles` | `{angles: [id]}`。使用者勾選要展開哪幾條，**這一步才真的開始**。一次最多 5 條 |
| `GET …/runs/:runId/events` | **SSE**：逐項進度、節流狀態、**每條角度做完的 `angle` 事件** |
| `POST …/runs/:runId/cancel` | 取消 ＝ 殺子程序 ＋ 標 `已取消`，**已寫入的保留**。**匯入與擴展走同一支** |
| `GET …/runs` ／ `/runs/:runId` | 作業紀錄。詳細那一支另外回 `angles`（**含沒被勾的那幾條**）|

> **`POST /runs` 不會直接開始抓。** 它回子問題讓使用者勾 ——
> 那一步是 REQ-0004 的驗收條件（「不是黑箱一次跑完」），不是可以省略的 UI 糖。
>
> **`angle` 事件與 `item` 事件是兩個層級。** 一條角度會產生好幾個 `item` 事件；
> 併成一種的話，作業紀錄就分不出「這幾個網址是哪一條角度找來的」。
>
> **每條角度帶 `seeds`（它是從既有的哪幾份長出來的），不帶「預估會找到幾個」。**
> 設計稿寫的是後者，而那個數字只可能是模型猜的 —— 理由在 ADR-0021。
>
> **`run` 對擴展多回四欄**：`topic`、`providers`（用了哪些模型）、
> `requests`（打了幾次）、`costUsd`。`requests` 是主要上限，
> 而**產生角度那一次也算在裡面** —— 使用者一條都沒勾，那一次仍然發生過。

### 匯入

| 端點 | 說明 |
|---|---|
| `POST …/import/urls` | 貼一批 URL。回一個 run |
| `POST …/import/files` | 上傳或指定本機路徑。**不支援的型別要列出來**，不是靜默略過 |

### 筆記與點註

| 端點 | 說明 |
|---|---|
| `POST …/items/:itemId/notes` | 建立點註。**body 只送位置**（`start`／`end`／`page`，或 `rect`）—— 見下面 |
| `GET …/items/:itemId/notes` | 那一份的點註，**依它在文件裡的位置排** |
| `GET …/notes` | 專題全部的點註 |
| `PATCH …/notes/:noteId` | 改註記內容。**錨點不動** |
| `DELETE …/notes/:noteId` | 刪掉。回 `removedEdges` —— 順便拿掉的線有幾條 |
| `POST …/rebuild` | **`derived/` 整批重算**，回重抽了幾份與每個錨點解得怎麼樣 |

> **建立點註時前端不送引文，只送位置。**
>
> 引文與前後文由伺服器從 `derived/` 切出來。那個分工不是為了省頻寬 ——
> 是為了讓「引文一定真的在那個位置上」成為一件**做不到相反的事**。
> 前端送引文的話，一個舊分頁、一個沒重整的畫面、一個改過的 JS，
> 都能存進一則「引文與位置對不上」的點註，**而那種點註在畫面上跟正確的一模一樣**。
>
> 回應裡的 `hit` 是**算出來的**（`exact`／`shifted`／`rect`／`not-found`），
> 資料庫裡沒有它 —— 存了它，那條「重算前後差異為 0」的驗收就變成在驗自己的快取。

> **`POST …/rebuild` 不碰兩樣東西**：`sources/`（一個位元組都不動，只讀），
> 以及**人的判定**（`status` 不重設，`origin='human'` 的列不看也不動）。
> 「重算」聽起來最無害，而它正是最容易把「機器不得覆寫人工判定」洗掉的動作。

### 作業的三顆按鈕是三件事

| 端點 | 何時能用 | 做什麼 |
|---|---|---|
| `POST …/runs/:runId/pause` ／ `/resume` | 執行中 | 停在**項與項之間**。正在做的那一項會做完 |
| `POST …/runs/:runId/cancel` | 執行中 | 不再往下做。**已寫入的保留** |
| `POST …/runs/:runId/undo` | **跑完之後** | 刪掉這次寫進去的資料與關聯 |

暫停與取消的差別要在畫面上看得出來：**暫停會回來，取消不會。**
而復原是第三件事 —— 它在跑完之後才出現（ADR-0023）。

`undo` 回一份報告，而**那份報告要說出「留下了什麼」**：
`keptItems`／`keptEdges`（你動過的）與 `keptAsEvidence`
（有一條留下來的關聯靠它當出處）。**只回一個刪除數的話，
使用者解釋不了為什麼圖上還有東西。**

失敗路徑：作業還在跑 → `RUN_STILL_ACTIVE`；找不到 → `RUN_NOT_FOUND`（404）。
暫停／續跑對一個不在執行中的作業 → `GRAPH_TRANSITION_INVALID`（跟取消同一個約定）。

> **`paused` 不在 `run.status` 裡**，它跟 `live` 一樣是執行時的事實（ADR-0023）。
>
> **`endedReason` 相反 —— 它在資料庫裡**（schema v8）。`null` ＝ 使用者自己按的取消、
> `shutdown` ＝ 關閉程式時一起停的、`stale` ＝ 上一次結束時它還沒跑完
> （**分不出**是關閉時沒趕上收尾，還是被強制結束）。
> 三者的 `status` 都是 `cancelled`，而畫面要說得出差別：
> 少了它，一個被強制結束留下來的作業看起來像「我自己取消了它」。

### `POST /api/system/shutdown` —— 結束 Cyclosa

**兩段式，而且第二段的門在伺服器端。**

| 請求 | 回什麼 | 做什麼 |
|---|---|---|
| `{}` | `{ activeRuns, shuttingDown: false }` | **什麼都不做** |
| `{ "force": true }` | `{ activeRuns, shuttingDown: true }` | 送出回應之後關掉行程 |

第一段的 `activeRuns` 就是畫面上那句確認要說的數字。
把二次確認只做在前端的話它是一個繞得過的提醒，
而**這顆按鈕會讓正在跑的抓取中斷**。

**沒有 `GET` 版本**：一個會被瀏覽器預抓、被書籤、被歷史重播的網址，
它的效果不該是「關掉這個程式」。

**瀏覽器關掉分頁不會走到這裡**，那是刻意的 ——
你可能開了兩個分頁，也可能是誤關，而 `beforeunload` 本來就不保證送得出去。

**`force` 那一段走的是一條有上限的關閉序列**（`interface/http/shutdown.ts`）：
叫作業停 → 等回應送出去 → 有上限地等它們收尾 → **收掉所有連線** → `close()`
也有上限，逾時就直接離開。收連線那一步不能少 —— Fastify 預設收不掉
進行中的請求，而進度通道就是一條進行中的請求。完整說明在
[`app-lifecycle.md`](app-lifecycle.md)。

被這條序列停下來的作業，`run.ended_reason` 會是 `shutdown`。

### `POST /api/cases/:slug/items/unread-all` —— 全部標成未讀

**同樣是兩段式，同樣的理由。**

| 請求 | 回什麼 | 做什麼 |
|---|---|---|
| `{}` | `{ read, cleared: 0, done: false }` | **一列都不改** |
| `{ "force": true }` | `{ read, cleared, done: true }` | 真的清 |

`read` 是「現在有幾份標著已讀」，`cleared` 是「真的被清掉幾份」——
**兩個數字在畫面上是兩句不同的話**，而只給一個會讓另一句變成使用者自己猜的。

**它不寫 `updated_at`**，所以清完之後專題不會跳到清單最上面 ——
已讀是關於「你」的事實，不是關於這份資料的事實。

> **這個動作有一個跨模組的副作用**：`domain/run/undo.ts` 把
> 「你讀過這一份」當成「人動過」的三種訊號之一，而復原一次作業時
> 人動過的會被留下來。**清掉已讀會讓既有作業的復原刪掉更多東西。**
> 那不是 bug，是它真的做的事 —— 而確認那句話必須說出來。

### `POST /api/cases/:slug/delete` —— 刪除專題

**第三個兩段式，而這一個的門更重。**

| 請求 | 回什麼 | 做什麼 |
|---|---|---|
| `{}` | `{ name, stats, bytes, done: false, movedTo: null }` | **一個檔都不動** |
| `{ "confirmName": "<專題名>" }` | `{ …, done: true, movedTo }` | 逐字對得上才刪 |

前面兩顆（結束、全部標成未讀）用一次確認就夠；這一顆要求**逐字打對名稱**，
因為它清掉的是**蒐集來的東西本身**，而那是這個工具存在的理由。
**比對在伺服器端** —— 只在畫面上比是繞得過的。

`bytes` 是**整個專題資料夾**的大小，含 `sources\` 的快照 ——
那通常就是大部分。只算 `case.sqlite` 的話，畫面會對一個 4 GB 的專題說「佔 200 KB」。

> **刪除是「搬」不是「刪」。** 資料夾搬進
> `backups\deleted-<slug>-<時間戳>\`（同磁碟區的 `rename`，瞬間、不多佔空間）。
> app 這一側就是刪掉了：清單上沒有它、狀態機裡沒有「已刪除」（REQ-0001）、
> **而且 app 永遠不讀 `backups\`**。那個資料夾是留給檔案總管的。
>
> 代價是**磁碟空間不會變多**，而那句話必須出現在畫面上 ——
> 否則使用者刪了一個 4 GB 的專題、去看硬碟、發現一點都沒空出來。

失敗路徑：名字對不上 → `CASE_NAME_MISMATCH`；有東西開著那個資料夾 →
`CASE_DELETE_BLOCKED`（**專題完整留著，沒有被刪掉一半**）。

**已封存的專題刪得掉** —— 這裡刻意不套 `assertMutable`：
封存的意思是「不再改動它的內容」，而刪除不是一次改動。
「封存起來，過一陣子確定不要了再刪」本來就是那兩個狀態最常見的走法。

### 改名為什麼要回整個 `CaseSummary`

因為 **`slug` 換了**，而它就是網址的一段。少回這一個欄位，
改完名之後使用者按任何一個連結都會 404 —— 而那個 404 看起來會像「專題不見了」。

改名**不動 `exports\<舊 slug>\`**：一份已經匯出的證據包裡面寫著當時那個名字，
而那份檔案可能已經寄出去了。**舊的匯出屬於舊的名字。**

失敗路徑：名字空的 → `CASE_NAME_EMPTY`（400）；撞到既有專題 →
`CASE_NAME_DUPLICATE`（409）；已封存 → `CASE_ARCHIVED`；
**資料夾搬不動**（有作業在跑、或檔案總管開著它）→ `CASE_RENAME_BLOCKED`（409）。
最後那一條**不是 `IO_UNEXPECTED`** —— 我們知道發生了什麼事，而使用者做得到那件事。

### 檢索

| 端點 | 說明 |
|---|---|
| `GET …/search` | `q` ＋ `mode`（`text`／`semantic`／`hybrid`）＋ 選填 `limit`。**語意不可用時全文照常回**，並在回應裡標示 `SEARCH_EMBED_UNAVAILABLE` |

**一支端點，兩個 `mode`。** 分成兩支的話前端要自己決定「這次能不能用語意」，
而那個決定的依據（有沒有設定嵌入模型）在伺服器這一邊。

### 回應：索引找候選，**正文確認**

```jsonc
{ "query": "台積電", "route": "bigram", "candidates": 2, "checked": 2, "verified": 1,
  "hits": [ { "kind": "item", "id": "…", "title": "…",
              "check": "hit",            // hit ／ miss ／ no-text
              "snippet": "…", "matchStart": 12, "matchEnd": 15 } ],
  "notices": [], "tookMs": 8 }
```

**`check` 是三種狀態，不是一個布林值** —— 跟 v0.8.0 的引文同一個形狀：

| | 意思 | 畫面上 |
|---|---|---|
| `hit` | 正文裡真的有這串字 | 摘要裡把它標起來 |
| `miss` | 正文讀得到，裡面沒有這串字 | **「可能是誤中」** |
| `no-text` | 正文讀不到，**沒驗** | 「正文不在，這一筆沒驗過」 |

中文走的是 bigram 索引，而它會跨詞誤中（查「台積電」會把
「來台積極…累積電力」撈成候選，因為那兩個 gram 都在）。
**索引表裡沒有位置，所以誤中在索引層看不出來** —— 唯一分得出來的地方是正文。

`miss` 的那幾筆**留在結果裡並標示**，不丟掉：丟掉會讓搜尋對一份
「只是正文被清掉」的資料說謊，而那是第三種狀態存在的理由。

**`matchStart`／`matchEnd` 是伺服器給的。** 前端自己在摘要裡再找一次字串，
會找到摘要裡**另一個**同樣的字，於是上色的不是命中的那一個。

成本有上界：索引最多回 400 個候選，其中最多讀 60 份正文回來確認 ——
**不設上界的話，搜尋的成本會跟著專題長大**。

### 匯出

| 端點 | 說明 |
|---|---|
| `POST …/export/evidence` | 選取子圖的證據包。**每條引文可回溯到 `item` 與字元區間** |
| `POST /api/diagnostics` | 去識別化的診斷檔。**產生檔案，不往外送** |

`POST …/export/evidence` 的 body **跟 `GET …/subgraph` 的查詢參數一模一樣**
（`focus`／`hops`／`layers`／`status`／`minConfidence`／`projection`…），
另加一個選填的 `nodeIds`：

| | 意思 |
|---|---|
| 沒送 `nodeIds` | 整塊子圖 |
| `nodeIds: [...]` | 只匯出這幾個節點，**以及兩端都在裡面的那些邊** |
| `nodeIds: []` | 「一個都沒選」→ `EXPORT_EMPTY_SELECTION`（400）。**跟沒送不一樣** |

參數一致不是巧合：**「選一塊子圖」的意思就是「你現在看到的那一塊」**，
換一組參數就等於換了一塊，而那時匯出的東西跟畫面上的對不起來。
伺服器端也是同一支 `subgraph()` —— 兩份遍歷實作遲早不一致，
而**不一致的時候使用者沒有辦法發現**：兩份都看起來很正常。

回應是一份摘要（不是檔案內容）：檔案落在
`<資料根>\exports\<專題>\<時間戳>\`，回的是**那個資料夾的路徑**、
三個檔名，以及節點／關聯／引文的數量。引文那三個數字**分開回**
（已核對／位置已移動／回溯不到），合成一個總數就把第三種藏起來了。

有回溯不到的引文時**仍然回 200**，`notice` 帶 `EXPORT_EVIDENCE_MISSING` ——
檔案照樣產生，而且那幾條在檔案裡標明了。

> **`POST` 不是 `GET`**：它會在磁碟上產生檔案，
> 而一個會產生東西的動作不該長得像一次讀取（可以被預抓、被快取、被重試）。

> **匯出不寫資料庫。** 引文的位置在正文重算之後變了也不更新 `edge_evidence`，
> 點註的 `anchor_ok` 也不重寫 —— 把位置對回去是 `POST …/rebuild` 的事。

---

## 這份合約刻意沒有的

| 沒有 | 為什麼 |
|---|---|
| `GET /graph` | ADR-0008。有了它前端遲早會呼叫，然後在 8k 節點時死掉 |
| 產生報告的端點 | 刻意排除的範圍。只做證據包匯出 |
| 任何往外送資料的端點 | 這是單機工具（REQ-0008 的「刻意不做」）|
| 認證 | 只綁 `127.0.0.1`。**這是既有風險不是疏漏**（ADR-0002 的代價那一節）|
| offset 分頁 | 5 萬筆規模下會逐列掃 |
