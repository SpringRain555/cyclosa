# 架構總覽

**這份是分層規則、擷取流程與檔案地圖的權威。** 欄位細節在 `data-model.md`，
狀態轉移在 `state-machines.md`，兩者都不要在這裡重複。

> **現況（2026-10-09 照實際的樹重畫）**：下面的檔案地圖**只畫到資料夾那一層**（少數單檔例外）——
> 個別檔案每一版都會加，寫到檔名的話這張圖每一版都會過期。2026-10-09 對的時候，它還列著四處不存在的資料夾
> （`src/config/`、`interface/sse/`、`providers/` 底下三個、`components/` 底下三個），漏了 `domain/research/`、`domain/run/`、
> `infrastructure/sources/` 與 `components/pdf/`（`lessons.md`）。
> `domain/annotation/` 在設計時叫 `domain/note/`（v0.6.0 改的名，因為它裝的是選擇器與錨點解析，不是「筆記」這個概念）。
>
> **一次完整流程的順序**（從匯入到匯出，以及每一步用不用模型）在
> `walkthrough.md`，不在這一份。
>
> 守門測試在 `tests/guards/`，**條數不寫在這裡**（這一段曾寫「現在八條」，而那個數字早就過期了）。
> **每一條都注入過真實違規驗證它會紅。**

---

## 一次研究與建圖的運作流程（Stage 19–22，v0.25.0 出貨）

```mermaid
flowchart TB
  subgraph IN[輸入]
    I1[拖入檔案／資料夾]
    I2[貼上 URL]
    I3[輸入主題／人物／事件]
  end

  I3 --> PLAN[規劃方向]
  PLAN -->|閘門一：照這份規劃開始| AG["找來源<br/>Claude Code ／ OpenAI 相容 API<br/>只搜尋，不抓取"]
  AG -->|候選 URL 清單| FQ
  I2 --> FQ
  I1 --> LOCAL[本機檔案登記]

  subgraph PIPE[擷取管線 · 唯一出口]
    FQ[排程佇列<br/>同網域間隔 · robots · 429 退避重試]
    FQ --> SNAP[["snapshot<br/>原始位元組 + SHA-256 + 抓取時間<br/>不可變"]]
    SNAP --> EXT[extract<br/>正文 · 語言偵測 · 抽取信心值]
    EXT --> RND[render<br/>重構排版]
  end

  LOCAL --> SNAP
  EXT --> IDX
  EXT --> EMB
  EXT -->|研究候選| DIGEST[初讀：有沒有關、繁中標題與摘要]
  DIGEST --> COLLECT[候選清單：等你上傳或說拿不到]
  AG --> COLLECT
  COLLECT -->|閘門二：完成蒐集| REVIEW[逐筆確認]
  REVIEW -->|閘門三：開始建圖| BUILD[建圖]
  BUILD -->|進圖且有正文| NER
  BUILD -->|只留書目且沒正文| REF[書目節點與人指定的引用]
  BUILD -->|丟掉已取得的資料| EXCLUDE[標已排除，可復原]

  subgraph UND[理解]
    NER[實體與具名關係抽取<br/>每條都要引文與字元區間]
    EMB[向量化]
    IDX[索引：CJK bigram ／ 拉丁詞彙]
  end

  UND --> DB[("專題 SQLite<br/>item · entity · edge<br/>edge_evidence · note · run")]
  REF --> DB
  EXCLUDE --> DB
  DB --> SUB["子圖 API<br/>focus + hops + filters<br/>（沒有整圖端點）"]
  SUB --> UI3D[3D 關聯圖]
  SUB --> RDR[閱讀器＋點註]
  UI3D -.使用者確認／否決／手動連線.-> DB
  RDR -.點註與筆記.-> DB
```

匯入本身不抽關聯，也不自動初讀；初讀只對研究候選執行。
已有正文的「只留著，不抽」保留原資料，不另建書目節點。

**這張圖只有一個要點：`agent` 找到的東西不能自己抓，一律回到 `FQ` 這個唯一出口。**
節流、robots、雜湊、manifest 只存在於那一層 —— 開第二條路等於讓它們全部失效。

## 分層與允許的匯入方向

```mermaid
flowchart TB
  UI["web/ · Vue 3 · 3D 圖 · 閱讀器<br/>i18n/zh-TW.ts 是 UI 字串唯一來源"]
  IF["interface/ · Fastify 路由 · SSE 進度"]
  AP["application/ · 用例編排 · 回傳 Result（含 correlation_id）"]
  DM["domain/ · 圖模型 · 狀態機 · 錯誤碼常數<br/>不 import 任何 infrastructure"]
  IN["infrastructure/ · db · fetch · extract · providers · fs"]

  UI -->|HTTP／SSE| IF --> AP --> DM
  AP --> IN
  IN -.只實作 domain 定義的介面.-> DM
```

三條最容易違反的：

- **`domain/` 零 I/O。** 不 import `node:fs`、`node:sqlite`，也不 import 其他層。
  它存在的理由就是讓真正會出錯的規則可以用純函式測試。
- **`domain/graph` 額外要求零依賴。** 它是 `rubricator` 已知的未來取用點 ——
  抽成套件的觸發條件寫在 ADR-0014：**兩邊的複本已經分岔，而那個分岔造成了一個 bug。**
  **現在不抽套件。**
- **業務規則不要寫進 route handler。** route 只做「解析請求 → 呼叫 service → 對映錯誤」。

## 檔案地圖

```
src/
├─ main.ts                單一實例檢查（healthz）、listen、關閉序列（@local-app/lifecycle）
├─ server.ts              建 Fastify app、掛路由；HOST／PORT／VERSION
├─ assets/                範例專題的語料（sample-corpus.json）與它的說明
├─ domain/                純邏輯，不 import infrastructure，也不 import 任何 npm 套件
│  ├─ case/               專題的狀態機與 slug 規則
│  ├─ graph/              node／edge 型別、四層、可信度、邊的狀態機、
│  │                      墓碑比對鍵、出處規則、投影三段 ←【零依賴】
│  ├─ ingest/             擷取階段的狀態機與規則；節流與退避的數字（唯一宣告處）
│  ├─ annotation/         W3C 選擇器模型（TextQuote／TextPosition／Fragment）與錨點解析
│  ├─ text/               空白等價的比對與原文座標 ←【引文與點註共用同一支】
│  ├─ entity/             實體識別鍵、別名比對、合併建議
│  ├─ sources/            來源網站的可讀性判定（歷史優先）
│  ├─ research/           研究的規則：蒐集、建圖、缺口評估，以及抽進圖（consolidate）
│  ├─ run/                作業的復原計畫（planUndo）
│  ├─ export/             證據包的形狀與它的 Markdown／JSONL ←【純函式】
│  ├─ search/             查詢解析、bigram 切分、混合排序 ←【純函式】
│  ├─ provider/           能力宣告與任務需求的配對規則、花費加總
│  └─ errors/             錯誤碼常數 ← error-codes.md 的單一真實來源
├─ application/           用例編排（*-service.ts、research-*.ts），一律回 Result{ok,code,correlationId}
├─ infrastructure/
│  ├─ db/                 node:sqlite、migrations/、repositories/、復原的刪除核心、舊擴展的清除
│  ├─ fetch/              節流器、限流時的退避重試、robots、快照寫入、manifest.jsonl
│  ├─ extract/            readability＋linkedom、pdfjs、語言偵測、抽取信心
│  ├─ index/              bigram 表寫入、FTS5、title_rank、向量 BLOB
│  ├─ providers/          模型服務（一層，不分子資料夾）：agent-*（Claude Code CLI、OpenAI 相容 API、
│  │                      把對話服務包成規劃用的 agent）、chat-*（Ollama、OpenAI 相容）、embed-ollama、
│  │                      設定與建議值（config.ts）、JSON 能力的量測紀錄、spawn-piped（子程序不經 shell）
│  ├─ sources/            內建的來源網站清單與使用者的設定
│  └─ fs/                 資料根與指標檔的路徑、專題的檔案、模型呼叫紀錄
├─ interface/http/        路由（routes.ts）、請求來源檢查（request-guard.ts，ADR-0036）、靜態檔、關閉
└─ shared/                Result、log、id、crash-trace

web/src/
├─ views/                 專題清單／關聯圖／閱讀器／作業紀錄／設定
├─ components/            面板（一層）：研究、抽進圖、點註、來源、資料位置、狀態說明、錯誤面板、原文／繁中切換…
├─ components/graph/      GraphView.vue（包住 3d-force-graph）、圖例、選取與關聯面板、合併、搜尋、證據包匯出
│                         objects.ts —— three.js 的幾何與材質工廠（顏色仍然只從 tokens.css 讀）
├─ components/pdf/        PDF 的版面檢視（PdfPages.vue）與 pdf.js 的載入
├─ workers/layout.worker.ts
├─ stores/                專題、圖、模型狀態、原文／繁中切換
├─ types/                 手寫的型別宣告（d3-force-3d）
├─ api.ts                 前端唯一呼叫 HTTP 的地方
├─ i18n/zh-TW.ts          **所有 UI 字串的唯一來源**
└─ styles/                tokens.css —— **顏色與記號的唯一來源**（ADR-0018）；base.css —— 按鈕、輸入框與版面的基礎
```

> **`domain/search/` 是純函式，`infrastructure/index/` 才碰資料庫。**
> 分開的理由跟 `domain/graph` 一樣：查詢怎麼切 bigram、混合排序怎麼加權，
> 那些是會出錯而且值得用純函式測的規則；**寫進索引表**才是 I/O。

## 幾個刻意的選擇

| 選擇 | 為什麼 |
|---|---|
| **只提供子圖 API，沒有整圖端點** | 有了整圖端點，前端遲早會呼叫它，然後在 8k 節點時死掉 |
| **3D 用 `3d-force-graph`，包在自訂 `GraphView` 介面後面** | 換自寫渲染的觸發條件寫在 ADR-0007：**8k 節點時 fps 掉到 30 以下** |
| **佈局跑 Web Worker** | 力導向會吃滿主執行緒，圖會卡住 |
| **不引 `sqlite-vec`** | 原生擴充，與「零原生模組」衝突。第一版用 BLOB 存向量、`Float32Array` 純 JS 比對，超過 5 萬筆才重新評估 |
| **中文檢索自建 bigram，不用 FTS5 `trigram`** | `trigram` 少於 3 個 unicode 字元的查詢**不會 match 任何列**，而中文查詢多半是 2 字詞 |

## 錯誤處理

碼的前綴就是分組（`FETCH_*`、`PARSE_*`、`PROVIDER_*`、`RESEARCH_*`、`CONSOLIDATE_*`……）。
**完整的碼只在 `src/domain/errors/codes.ts`**，這裡不列 —— 這一行原本列了六組，而實際已經有十二組。
**UI 只顯示繁中訊息，碼只進日誌**；每次操作帶 `correlation_id`。

**絕不因為單一項目失敗讓整批失敗** —— `部分失敗` 是一等公民（見 `state-machines.md`）。
