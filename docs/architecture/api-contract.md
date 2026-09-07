# API 合約

**這份是端點、請求／回應形狀與錯誤對映的權威。**
業務規則在 `domain/`（見 `overview.md` 的分層），錯誤碼的意義在 `error-codes.md`。

> **現況（2026-09-07，Stage 6）：一部分實作了。**
>
> **已經存在**：系統（`/healthz`、資料根）、專題（清單／建立／封存）、
> **匯入**（`/import/urls`、`/import/file`）、**作業紀錄**（`/runs`、`/runs/:id`、
> **SSE `/runs/:id/events`**、`/cancel`）、**資料節點與閱讀器**
> （`/items`、`/items/:id`、`/content`、`/snapshot`、`/read`、`/exclude`、
> `/restore`、`/retry`）。
>
> **還不存在**：子圖 API 與 `/subgraph/size`（Stage 7）、關聯與裁決（Stage 8）、
> provider 與擴展的 `/runs` 那一組（Stage 9）、點註（Stage 10）、
> 匯出（Stage 11）、檢索（Stage 12）。
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
| `projection` | 實體投影門檻，預設 `3`（見 `data-model.md` 的三段）|

回傳節點與邊，**外加每條 `named` 邊的可信度等級與獨立來源數** ——
否則側欄為了顯示一行「出處 5 筆 · 2 個獨立來源」要再打一次 API。

**超過渲染上限時回 `GRAPH_SUBGRAPH_TOO_LARGE`（413），不是回一個巨大的結果。**

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
| `GET /api/providers` | 各角色目前設定了什麼、能力宣告是什麼 |
| `POST /api/providers/test` | 實際打一次，回能力偵測結果 |

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
| `POST …/items/:itemId/read` | 標記已讀。**正交旗標，不是狀態轉移** |
| `POST …/items/:itemId/exclude` ／ `/restore` | 已排除／復原。**只有人能做** |
| `POST …/items/:itemId/retry` | 重試失敗的項目。**不產生第二個節點** |

### 關聯與裁決

| 端點 | 說明 |
|---|---|
| `GET …/edges/:edgeId` | 含引文、獨立來源數、可信度等級與構成事實、校準比例 |
| `POST …/edges` | **手動建立。一建立就是 `已確認` ＋ `origin='human'`** |
| `POST …/edges/:edgeId/transition` | `{action}`：`confirm`／`reject`／`withdraw`／`restore`。**六條轉移都走這一個端點**，不在轉移表上的組合回 `GRAPH_TRANSITION_INVALID` |
| `GET …/queue` | 裁決佇列。**只有 `layer='named'` 的邊會出現在這裡** |

### 擴展作業

| 端點 | 說明 |
|---|---|
| `POST …/runs` | 開一次 run。回傳的是**多視角子問題清單**，還沒開始抓 |
| `POST …/runs/:runId/angles` | 使用者勾選要展開哪幾條，**這一步才真的開始** |
| `GET …/runs/:runId/events` | **SSE**：逐項進度、節流狀態、目前在做什麼 |
| `POST …/runs/:runId/cancel` | 取消 ＝ 殺子程序 ＋ 標 `已取消`，**已寫入的保留** |
| `GET …/runs` ／ `/runs/:runId` | 作業紀錄 |

> **`POST /runs` 不會直接開始抓。** 它回子問題讓使用者勾 ——
> 那一步是 REQ-0004 的驗收條件（「不是黑箱一次跑完」），不是可以省略的 UI 糖。

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
