# 市場調查

**這一份是結論。** 查詢過程與可回溯的來源在 `query-log.md` ＋ `sources/manifest.jsonl`，
規則（可信度分級、重查門檻）在 `index.md`。

| | |
|---|---|
| 初次調查 | **2026-09-04** —— 沒有留查詢紀錄 |
| 重跑 | **2026-09-06** —— 55 筆來源，52 筆有 SHA-256 |
| 下次例行重查 | **2027-03**（門檻見 `index.md`）|

> **每一條結論都標了日期與級別。** 標 **2026-09-06** 的可以逐條回溯到
> `sources/manifest.jsonl` 的某一個雜湊；標 **2026-09-04** 的**不行** ——
> 那次沒有留紀錄，而且刻意不事後補（憑印象重建的紀錄比沒有更糟，它看起來像證據）。

---

## 結論：七個賽道，沒有一個涵蓋這個組合

要找的組合是：**主動擴展 ＋ 每條關聯帶出處 ＋ 圖瀏覽 ＋ 內建閱讀器 ＋ 本機保存 ＋ 可續接**。

| 賽道 | 代表 | 缺什麼 | 級別 |
|---|---|---|:--:|
| **筆記圖** | Obsidian、Logseq、Heptabase、Scrintal、TheBrain | 線**全靠人手動連**、型別扁平、無爬取、無出處 | C（09-04）|
| **AI 研究助理** | **Gemini Notebook**（原 NotebookLM）、Anara、Elicit | 綁單一模型、**來源數上限**、**無圖**、無本機保存 | **A（09-06）** |
| **調查／OSINT** | Aleph（**日落**）、Datashare、Maltego、i2、Linkurious | 要 Docker＋Elasticsearch 或商業授權、**LLM 不主動擴展**、繁中弱 | **A（09-06）** |
| **文獻圖譜** | Connected Papers、ResearchRabbit、Litmaps、Inciteful | **只吃論文**、關係型別不可自訂 | C（09-04）|
| **LLM 圖譜函式庫** | GraphRAG、LightRAG、cognee、Graphiti | **是函式庫不是應用**：無 UI、無閱讀器、**無人工裁決** | **A（09-06）** |
| **保存／稍後讀** | ArchiveBox、SingleFile、Karakeep、Linkwarden | **沒有關聯圖**，也不做擴展 | **A（09-06）** |
| **深度研究代理** | STORM、GPT-Researcher | **輸出是一篇報告**，不是可累積、可續接、可再展開的結構 | **A（09-06）** |

台灣本地也沒有對手（資策會的「III 知識圖譜標記工具」是面向企業的**標記工具**）。**C 級，09-04。**

---

## 授權盤點（A 級，2026-09-06 實查）

**本專案採 MIT。混進 AGPL 程式碼會讓整份授權失效** —— 所以下面每條判讀都標明**借的是概念還是程式碼**。

| 授權 | 專案 | 怎麼用 |
|---|---|---|
| **MIT** | Aleph、**followthemoney**、ArchiveBox、GraphRAG、LightRAG、STORM、sigma.js、cosmos.gl、`3d-force-graph`、`d3-force-3d` | 概念與程式碼都可借；後兩者直接當依賴 |
| **Apache-2.0** | `@mozilla/readability`、`pdfjs-dist`、trafilatura、cognee、Graphiti、GPT-Researcher | 可當依賴 |
| **ISC** | `linkedom` | 可當依賴 |
| **AGPL-3.0** | **Datashare、SingleFile、Karakeep、Linkwarden、Zotero** | **只讀概念，一行程式碼都不抄、也不當依賴** |

### 三條更正 2026-09-04 那份盤點的

1. **Zotero 用 GitHub API 查不到 AGPL** —— 它回 `NOASSERTION`（商標條款讓分類器放棄）。
   **要直接讀 `COPYING`** 才看得到「distributes the Zotero source code under the AGPLv3」。
   結論不變，但 2026-09-04 那份宣稱的方法（GitHub API 實查）**問不出那個答案**。
2. **Linkwarden 是 AGPL-3.0，而它原本不在紅線名單上** —— 它出現在賽道表裡卻沒進盤點表。**現在補上。**
3. **`cosmos.gl` 的 repo 是 `cosmosgl/graph`**，不是 `cosmograph-org/cosmos`（後者會轉址）。

### 一條存活狀態的更新

**Aleph 正在日落。** README 首段就是 `PROJECT STATUS: SUNSETTING`：OCCRP 轉向專有的
Aleph Pro，開源版**維護到 2025-12-31 為止**。授權還是 MIT、程式碼還在，
但**它是一份不再維護的程式碼**。這個賽道真正還活著的可借部分是
**`alephdata/followthemoney`**（MIT、2026-02-28 仍有 push、未封存）。

> **STORM 也要留意**：`pushed_at` 是 **2025-09-30**，將近一年沒動。
> 借它的**概念**沒問題（那是一篇論文的實作），但不要期待它會跟上。

---

## 八個直接改變設計的發現

前六條是 2026-09-04 的，**第 4、5、7、8 條是這次新增或改寫的**。

### ① Obsidian 圖被批評「好看但沒用」，而原因具體且可修　`C · 09-04`

社群歸納三條：關係層唯讀（**沒辦法把剛想到的關係拖出來**）、圖沒有型別
（**無法「只顯示人」**）、超過約 500 節點只是變擠。Excalibrain 靠**具名連結**造層次。

→ **反過來就是必要條件**：邊要可手動建立、節點與邊要有型別且可篩選、預設只渲染子圖。
**借的是概念。**

> **「約 500 節點」是 C 級，不要拿它當數字用。** 這次沒有回到原始出處。
> 我們自己的節點預算是 v0.12.0 用合成資料量出來的，不是從這句話推導的。

### ② 3D 在 HCI 研究裡不是免費的升級　`B · 09-04`

遮擋與深度感知讓「精確比較」「社群偵測」比 2D 慢；3D 的優勢在**空間記憶與整體結構感**。

→ **3D 只做瀏覽與結構感**，精確操作在側欄的 2D 面板，**必須提供一鍵切 2D 平面佈局**。
**寫進 ADR-0007。借的是概念。**

### ③ 焦點＋脈絡與語意縮放是成熟解法　`B · 09-04`

關注度決定顯示層級；縮放時**改變表示型態**而非只放大。

→ 子圖 API 直接對應 `focus` ＋ `hops` ＋ `filters`。**借的是概念。**

### ④ 正文抽取有公開評測　`B · 09-04`（數字未重驗）

2026 WCXB：`rs-trafilatura` F1 0.910、Python `trafilatura` 0.883、
**Mozilla Readability 中位數 0.970 最高但平均較低**（簡單頁很穩、複雜頁掉得快）。

→ Node 端用 `@mozilla/readability`（**Apache-2.0，09-06 實查確認**，當依賴）＋ `linkedom`
（**ISC，09-06 實查確認**），**並記錄抽取信心值**；信心低的標記出來，**不靜默交出爛正文**。

> **這次沒有回到原始評測。** 那幾個 F1 數字仍然是 B 級、仍然標 09-04。
> 它們只用來支持「用 Readability 但要記信心值」這個方向，**不用來宣稱任何精確度**。

### ⑤ 標註錨點的標準答案已經存在　`A · 09-04`

**W3C Web Annotation Data Model。** Zotero 與 Hypothes.is 都**同時存
`TextPositionSelector`（快）與 `TextQuoteSelector`（抗漂移）**。

→ 直接採用。快照不可變，所以錨點**釘在 snapshot 上**，重構排版只是投影。
**借的是規格與概念，Zotero 的程式碼一行都不碰（AGPL）。**

### ⑥ STORM 的多視角提問不是憑空生成的　`A · 09-06`（**改寫**）

原本這一條寫成「擴展前先產生多視角子問題」，而讀了 README 之後發現**漏掉了最重要的機制**：

> **Perspective-Guided Question Asking**: Given the input topic, STORM discovers different
> perspectives **by surveying existing articles from similar topics** and uses them to control
> the question-asking process.

**視角是從「相似主題的既有文章」歸納出來的，不是叫模型想幾個角度。**
Co-STORM 再加一層：**人可以注入發言來引導討論方向**。

→ 我們的擴展要照這個順序：**先看這個專題裡已經有什麼**（既有的 `item` 與 `entity`），
從那裡歸納視角，再產生子問題讓使用者勾選。
**一個從空白開始想角度的擴展，跟「叫 LLM 隨便發散」沒有差別。**
Co-STORM 的「人注入發言」對應我們的「勾選要展開哪幾條」。**借的是概念。**

### ⑦ 三個 LLM 圖譜函式庫都收斂到「出處要回溯到原始資料」　`A · 09-06`（**新增**）

**Graphiti**（Apache-2.0）的 context graph 有四個構件，其中兩個直接對應我們的設計：

| Graphiti | 對應到我們的 |
|---|---|
| **Episodes（provenance）** —— raw data as ingested；every derived fact traces back here | `edge_evidence` → `item` → 不可變的 `sources/` 快照 |
| **Facts with temporal validity windows** —— 資訊改變時舊事實**被作廢而不是刪除** | 已否決是**墓碑**（設計稿的差異 2），不是把列刪掉 |
| Custom types via Pydantic models | `entity.type` ／ `edge.rel` 可自訂型別 |
| Hybrid retrieval（semantic ＋ keyword ＋ graph traversal） | v0.11.0 的 bigram ＋ 向量 ＋ 子圖遍歷，**三條併用** |

**這是收斂，不是抄襲** —— 兩邊各自從「LLM 抽出來的關係不可信」這個前提出發，
走到同一個結構。**但差別要講清楚**：Graphiti 的事實作廢是**自動**的（新資訊進來就蓋掉舊的），
我們的是**人工裁決**且**機器永遠不得覆寫**。那正是這個工具存在的理由。**借的是概念。**

### ⑧ 嵌入模型換掉就全毀，而且它不會報錯　`A · 09-06`（**新增，改了資料模型**）

LightRAG 的 README 明寫：

> The Embedding model **must be determined before document indexing**, and the same model must
> be used in the query phase. **Once selected, embedding models generally cannot be changed.**
> If changed, you will need to re-embed all text chunks, entities, and relationships.

**這是一個靜默失效**：換了模型之後，舊向量與新查詢向量的餘弦相似度**照樣算得出一個數字** ——
只是那個數字沒有意義。使用者看到的是「搜尋結果變爛了」，不是錯誤訊息。

→ **資料模型要改**：向量列必須記 `model` ＋ `dim` ＋ `created_at`，
**查詢時模型不符就拒絕比對並報錯**，不是回一堆看起來正常的垃圾。
**這條寫進 `data-model.md` 與 ADR-0009 的補充。借的是概念。**

> 同一份 README 還推薦本機部署用 **`BAAI/bge-m3`** —— 與這個專案選的嵌入模型一致。
> **這是獨立佐證，不是我們選它的理由**（選它的理由是多語言支援）。

---

## 兩個從別的賽道學到的「不要做」

- **不做報告產生**（深度研究代理那一欄的共同問題）。一個會生成散文的工具，
  使用者就不會回去看出處了 —— 而出處是這整個東西的重點。
  只匯出「選取子圖的證據包」（Markdown ＋ 引文 ＋ 來源清單）。
- **不做「一鍵生成關聯圖」**（LLM 圖譜函式庫那一欄）。沒有人工裁決的圖，
  看起來很有道理但沒有人敢用。所以邊的狀態機規定**機器永遠不得覆寫人工判定**。

## 一個從別的賽道學到的「一定要做」　`A · 09-06`（**新增**）

**ArchiveBox 的第一原則**：

> We aim to make your data immediately useful, and **kept in formats that other programs can
> read directly** … stores data in **ordinary files & folders** — no complex proprietary formats,
> **all data is readable without needing to run ArchiveBox**.

這正是 ADR-0003 已經決定的事（`sources/` 存原始位元組、`notes/*.md` 存純 Markdown、
一個專題就是一個資料夾）。**列在這裡是因為它值得被當成一條可以檢查的標準**：

> **把資料夾整個複製到一台沒有裝 Cyclosa 的機器上，裡面的東西還讀不讀得懂？**

這是 REQ-0001 那條「整個複製走之後在另一台機器上打得開」的更強版本 ——
不只要打得開，還要**不需要這個工具就讀得懂**。**借的是概念。**

---

## 先例佐證：FollowTheMoney 把 `Mention` 與 `Similar` 當成獨立型別　`A · 09-06`

`alephdata/followthemoney`（**MIT**）是投查記者用的實體資料模型，**70 個 schema**。
它把關係也建模成實體（`Directorship`、`Employment`、`Membership`、`Ownership`、`Family`、
`Associate`、`Representation`、`Succession`），而其中兩個特別值得注意：

- **`Mention.yaml`** —— 「這份文件提到這個實體」
- **`Similar.yaml`** —— 「這兩個東西相似」

**它把「提及」與「相似」跟具名關係分開，是一個獨立於我們的設計。**
這正是設計稿的「關聯四層」（衍生／具名關係／共同提及／相似度）—— 兩邊各自到達同一個結論。

→ **這是關聯四層最強的一條佐證**，也是 `entity.type` 值域的現成參考。
**MIT，概念與程式碼都可借** —— 但我們只借它的分類概念，不引它的 Python 套件
（這個專案零 Python）。

## 這一份沒有涵蓋的

| 沒查 | 為什麼 |
|---|---|
| Maltego、i2、Linkurious 的實際功能 | 商業授權、無公開 repo。它們在表裡的角色是「這個賽道有商業解」 |
| Heptabase、Scrintal、TheBrain、Connected Papers、ResearchRabbit、Litmaps | 閉源，要逐一註冊試用。**判讀維持 2026-09-04 並標 C 級**，不假裝重查過 |
| Obsidian「約 500 節點」的原始出處 | C 級的社群歸納，**不拿它當數字用** |
| 2026 WCXB 的原始評測數據 | 仍是 B 級、仍標 09-04 |
