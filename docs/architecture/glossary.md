# 詞彙表

**這份是「中文詞 ↔ 識別字」與「不可以叫什麼」的權威。**
概念的完整定義在各自的文件裡（這裡只給一句話 ＋ 指路）。

> **為什麼需要這一份。** 這個專案的介面一律繁體中文、程式碼一律英文，
> 而中間那層對映如果沒有寫下來，**同一個東西會長出三個名字**：
> 文件裡叫「資料節點」、程式裡叫 `document`、UI 上叫「文件」——
> 然後沒有人確定 `document` 是不是就是「資料節點」。
>
> **對 LLM 尤其嚴重**：它會照著它看到的那個名字繼續造新名字。

---

## 核心名詞

| 中文（UI 與文件）| 識別字 | 一句話 | 權威在哪 |
|---|---|---|---|
| **專題** | `case` | 工作單位。一個專題＝一個資料夾＝一個 SQLite | `data-model.md` |
| **資料節點** | `item` | 抓回來或匯入的一份東西（網頁／PDF／圖片／文字）| `data-model.md` |
| **實體** | `entity` | 人、組織、地點、事件、作品、概念 | `data-model.md` |
| **關聯** | `edge` | 兩個節點之間的一條連線 | `data-model.md` |
| **出處** | `edge_evidence` | 一條關聯的引文 ＋ 它在哪個 `item` 的哪個字元區間 | `data-model.md` |
| **稽核紀錄** | `edge_audit` | 一次狀態轉換的紀錄。只增不刪 | ADR-0016 |
| **點註** | `note` | 錨在快照上的一段註記。**它也是圖上的節點** | ADR-0010 |
| **擴展作業** | `run` | 一次擴展或匯入。有自己的狀態機 | `state-machines.md` |
| **快照** | `snapshot` | 抓回來的原始位元組。**不可變** | ADR-0003 |
| **衍生物** | `derived` | 從快照算出來的東西。**可以整批重算** | ADR-0003 |
| **資料根目錄** | `dataRoot` | 資料住的地方，在 repo 之外 | ADR-0004 |
| **指標檔** | `systemPaths` | 記著資料根在哪的那個檔 | `storage-layout.md` |
| **切入角度** | `angle` | 擴展的一條多視角子問題。**使用者勾選之後才展開** | `data-model.md` |
| **沙箱** | `sandbox` | agent 子程序的工作目錄。**裡面不得出現抓取產物** | ADR-0006 |
| **能力宣告** | `capabilities` | 一個 provider 有沒有 `browse`／`tools`／`json_schema`／`vision`，以及 context 多大 | ADR-0006 |

## 狀態的值

**資料庫存英文識別字，UI 顯示中文。** 對映只有一處：`web/src/i18n/zh-TW.ts`。

| 狀態機 | 中文 | 識別字 |
|---|---|---|
| **專題** | 新建／蒐集中／已就緒／已封存 | `new` / `collecting` / `ready` / `archived` |
| **資料節點** | 待處理／已擷取／已解析／已納入／已排除／失敗 | `pending` / `fetched` / `parsed` / `included` / `excluded` / `failed` |
| **擴展作業** | 排隊／執行中／已完成／**部分失敗**／已取消／失敗 | `queued` / `running` / `done` / **`partial`** / `cancelled` / `failed` |
| **關聯** | 待查證／已確認／已否決 | `pending` / `confirmed` / `rejected` |

## 關聯的四層（ADR-0015）

| 中文 | 識別字 | 進裁決佇列 |
|---|---|:--:|
| 衍生 | `derived` | 否 |
| 具名關係 | `named` | **是** |
| 共同提及 | `comention` | 否 |
| 相似度 | `similarity` | 否 |

> **`derived` 這個字在這個專案裡有兩個意思，而它們不衝突但很容易混：**
> `derived/` 資料夾（衍生物：重構後的排版）與 `edge.layer='derived'`（衍生關聯：轉載／翻譯）。
> **兩者都是「從別的東西來的」，但一個是檔案、一個是關聯。**
> 程式裡前者一律寫 `derivedDir`／`derivedPath`，後者一律寫 `EdgeLayer.Derived`。

## 可信度（ADR-0017）

| 中文 | 識別字 |
|---|---|
| 弱／中／強 | `weak` / `medium` / `strong` |
| 獨立來源數 | `independentSourceCount` |
| 校準比例 | `calibrationRate` |
| 樣本不足 | `insufficientSample` |

---

## 不可以叫什麼

**這一節比上面那張表更重要。** 每一條都有一個具體的壞法。

| 不要用 | 用什麼 | 為什麼 |
|---|---|---|
| `document` | `item` | 「資料節點」包含圖片與純文字，不只是文件。而且 `document` 在前端會跟 DOM 的 `document` 撞名 |
| `node` | `item` 或 `entity` | 圖上有**兩種**節點，`node` 分不出是哪一種。只有在明確指「圖上的一個點」時才用（例如 `nodeCount`）|
| `link` | `edge` | `link` 在前端是 `<a>`，在 `3d-force-graph` 的 API 裡又是它自己的邊 —— 三個意思 |
| `source` | 分三個：`sourceUrl`／`snapshot`／`edge.source` | 「來源」在這個專案有三個意思：來源網址、原始快照、關聯的起點。**單獨一個 `source` 永遠是模糊的** |
| `score` | `confidence`（存的分數）或 `confidenceTier`（顯示的等級）| 混用會讓「不顯示小數」這條規則失守 —— 有人看到 `score` 就會把它印出來 |
| `verified` | `confirmed` | 「已確認」是**人的判斷**，不是機器驗證過。`verified` 讀起來像後者 |
| `deleted` | `excluded`（節點）或 `rejected`（關聯）| **狀態機裡沒有「已刪除」** —— 刪除就是刪除，不留狀態（REQ-0001）|
| `cache` | `derived` | 快取可以隨時丟掉而不影響正確性；`derived/` 丟掉之後要重算才能用。**叫它 cache 會讓人以為丟掉沒差** |
| `crawl` | `fetch` | 這個工具**只抓被指名的頁面，不做整站爬取**。名字要反映那條界線 |
| `report` | `evidencePack` | **不做報告產生**是刻意排除的範圍。程式裡出現 `report` 就是那條界線開始鬆動 |
| `graph`（當端點名）| `subgraph` | **沒有整圖端點**（ADR-0008）。連名字都不要留下那個可能 |
| `sync` | —— | 這個工具沒有同步。多台機器同步是一個還沒做的決定（ADR-0004）|
| `user` | —— | **單機單人工具，沒有使用者概念。** 出現 `userId` 就代表有人在往多人方向走 |
| `perspective` | `angle`（切入角度）| STORM 用 perspective，而我們的 UI 字是「切入角度」。**兩個字在同一個 codebase 裡指同一件事**就會開始有人以為它們不一樣 |
| `estimate`（子問題上的）| `seeds` | 設計稿寫的是「預估會找到幾個」，而那個數字只可能是模型猜的。**留下這個名字，就會有人去把它填起來**（ADR-0021）|
| `download`（agent 的）| —— | **agent 不抓東西。** 程式裡出現這個字就是 ADR-0006 第 5 條開始鬆動 |

## 兩個容易寫反的

**1. 「已否決」與「已排除」不是同一件事**（ADR-0016）：

| | 意思 | 對象 |
|---|---|---|
| 已否決 `rejected` | **這條關係不是真的** | 關聯 |
| 已排除 `excluded` | **這份資料對這個專題沒用** | 資料節點 |

兩者都是墓碑、都可復原、圖上共用打叉的畫法 —— **但不可互推**。

**2. 「出處筆數」與「獨立來源數」不是同一個數字**（ADR-0015）：

出處 5 筆可能只有 2 個獨立來源（其中三筆是同一則的轉載）。
**UI 上永遠兩個一起顯示**，只顯示前者會系統性高估。

**3. 「找到」與「抓到」不是同一件事**（ADR-0006 第 5 條）：

| | 誰做的 | 產物 |
|---|---|---|
| 找到 | `agent`（搜尋）| **一個網址** |
| 抓到 | 擷取管線 | 快照、`manifest.jsonl` 的一列、一個 `item` |

`run_angle.found_urls` 數的是前者，`run_item` 記的是後者 ——
**兩個數字不會相等**（robots 不准的、404 的、已經在專題裡的都在中間掉了）。

---

## 檔名與識別字的大小寫

| 東西 | 慣例 | 例 |
|---|---|---|
| 資料表與欄位 | `snake_case` | `edge_evidence`、`char_start`、`read_at` |
| TypeScript 變數與函式 | `camelCase` | `independentSourceCount` |
| 型別與類別 | `PascalCase` | `EdgeLayer`、`SubgraphQuery` |
| 錯誤碼 | `SCREAMING_SNAKE` | `PROVIDER_CAPABILITY_MISSING` |
| 檔名（`src/`）| `kebab-case.ts` | `subgraph-query.ts` |
| Vue 元件 | `PascalCase.vue` | `GraphView.vue` |
| i18n 的 key | `dot.case` | `case.list.empty.title` |

**資料庫是 `snake_case` 而 TS 是 `camelCase`，轉換只在 repository 層做一次** ——
不要讓 `char_start` 這種名字漏進 domain。
