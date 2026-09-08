# API 合約

**這份是端點、請求／回應形狀與錯誤對映的權威。**
業務規則在 `domain/`（見 `overview.md` 的分層），錯誤碼的意義在 `error-codes.md`。

> **現況（2026-09-07，Stage 7）：一部分實作了。**
>
> **已經存在**：系統（`/healthz`、資料根）、專題（清單／建立／封存）、
> **匯入**（`/import/urls`、`/import/file`）、**作業紀錄**（`/runs`、`/runs/:id`、
> **SSE `/runs/:id/events`**、`/cancel`）、**資料節點與閱讀器**
> （`/items`、`/items/:id`、`/content`、`/snapshot`、`/read`、`/exclude`、
> `/restore`、`/retry`）。
>
> **Stage 7 新增**：`/subgraph`、`/subgraph/size`、**`/subgraph/focus`**。
>
> **Stage 8 新增**：`/edges/:edgeId`、`POST /edges`、`/edges/:edgeId/transition`、`/queue`。
>
> **Stage 9 新增**：`GET`／`POST /api/providers`、`/api/providers/test`、
> **`POST …/runs`** 與 **`POST …/runs/:runId/angles`**（擴展的兩階段）。
>
> **還不存在**：點註（Stage 10）、匯出（Stage 11）、檢索（Stage 12）。
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
那是 Stage 7 第一次人工驗收改掉的：最後匯入的那一份剛好一條關聯都沒有，
於是打開專題看到的是畫面正中央一個孤零零的點 —— 技術上完全正確，
**但它讓人以為圖壞了**。專題是空的就回 `focus: null`，畫面顯示空狀態。

### `GET /api/cases/:caseId/subgraph/size`

**同樣的參數，只回數量，不回內容。**

```jsonc
{ "ok": true, "data": { "hops": { "1": 12, "2": 143, "3": 1806 },
                        "budget": 2000, "overBudget": ["3"] } }
```

工具列的跳數格用它**即時顯示每一格會帶進來幾個節點**，超過預算的那一格標琥珀色
（ADR-0018 的 D 層顏色只在面板，這裡是面板）。

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
> **這支查詢只數不拉資料，效能預算 < 50 ms**（Stage 13 量測）。

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
| `GET /api/providers` | 各角色目前設定了什麼、能力宣告是什麼、**跑不跑得動它要跑的任務（缺哪幾樣）**。另外回 Ollama 上真的有的模型清單（`chatModels`，**`null` 代表連不上**，不是「一個都沒有」）|
| `POST /api/providers` | 存設定。設定檔在 `%LOCALAPPDATA%\Cyclosa\providers.json`，**不在資料根裡**（storage-layout）|
| `POST /api/providers/test` | `{role}`：**實際打一次**。回 `{ok, code, costUsd, elapsedMs}` |

> **`GET` 與 `test` 是兩件事，而且分開得很刻意。**
> 打開設定頁**不該產生費用** —— 所以 `GET` 對 `agent` 只跑 `--version`、
> 對 `chat` 只讀 `/api/tags`（本機、免費）。
> `test` 是使用者按的按鈕，**而畫面上那個按鈕旁邊要先講它會不會花錢**。
>
> `costUsd` 的 **`null` 與 `0` 是兩件事**：本機模型的金額成本真的是零；
> 一個沒回報成本的 provider 是「不知道」。**不估算**（ADR-0006 的補記）。

### 專題

| 端點 | 說明 |
|---|---|
| `GET /api/cases` | 清單 ＋ 每個專題的統計（節點數、實體數、關聯數、**待查證幾條**、最後擴展時間）|
| `POST /api/cases` | 建立。三次點擊以內完成的那一步 |
| `POST /api/cases/open` | 開啟既有資料夾（把一個搬過來的專題掛回來）|
| `POST /api/cases/:id/archive` ／ `/reopen` | 封存與重新開啟 |

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
> 那條路只有擴展作業走得到（Stage 9），而擴展是從 `POST …/runs` 進來的。
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
| `POST …/notes` | 建立點註。`selector_json` 是 W3C 選擇器陣列（ADR-0019）|
| `GET …/items/:itemId/notes` | 那一份的點註 |
| `GET …/notes` | 專題全部的點註 |

### 檢索

| 端點 | 說明 |
|---|---|
| `GET …/search` | `q` ＋ `mode`（`text`／`semantic`／`hybrid`）。**語意不可用時全文照常回**，並在回應裡標示 `SEARCH_EMBED_UNAVAILABLE` |

### 匯出

| 端點 | 說明 |
|---|---|
| `POST …/export/evidence` | 選取子圖的證據包。**每條引文可回溯到 `item` 與字元區間** |
| `POST /api/diagnostics` | 去識別化的診斷檔。**產生檔案，不往外送** |

---

## 這份合約刻意沒有的

| 沒有 | 為什麼 |
|---|---|
| `GET /graph` | ADR-0008。有了它前端遲早會呼叫，然後在 8k 節點時死掉 |
| 產生報告的端點 | 刻意排除的範圍。只做證據包匯出 |
| 任何往外送資料的端點 | 這是單機工具（REQ-0008 的「刻意不做」）|
| 認證 | 只綁 `127.0.0.1`。**這是既有風險不是疏漏**（ADR-0002 的代價那一節）|
| offset 分頁 | 5 萬筆規模下會逐列掃 |
