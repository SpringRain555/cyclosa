# 市場調查

**這一份是結論。** 查詢過程與可回溯的來源在 `query-log.md` ＋ `sources/manifest.jsonl`，
規則（可信度分級、重查門檻）在 `index.md`。

| | |
|---|---|
| 初次調查 | **2026-09-04** —— 沒有留查詢紀錄 |
| 重跑 | **2026-09-06** —— 55 筆來源，52 筆有 SHA-256 |
| 重查 | **2026-09-28** —— 要對外宣稱差異之前＋ Stage 21–24 之前；40 筆新來源，全部有 SHA-256 |
| 下次例行重查 | **2027-03**（門檻見 `index.md`）|

> **每一條結論都標了日期與級別。** 標 **2026-09-06** 的可以逐條回溯到
> `sources/manifest.jsonl` 的某一個雜湊；標 **2026-09-04** 的**不行** ——
> 那次沒有留紀錄，而且刻意不事後補（憑印象重建的紀錄比沒有更糟，它看起來像證據）。

---

## 2026-09-28 重查：五件事要改

> **觸發不是時間到**（上次是 09-06），是 `index.md` 門檻表沒寫到的一種：**要在對外的文件裡宣稱
> 「跟別人不一樣」之前**。宣稱會被讀者拿去對照，一條過期的判讀在那裡的代價比在 repo 裡大。
> 另外 Stage 21–24 是大功能，本來就在門檻內。查詢過程在 `query-log.md` 的同日一節。

**整體結論沒有翻**：這次查到的 30 多個產品與專案裡，**沒有一個同時做到**「研究代理找來源 ＋
每條關聯帶找得到的引文 ＋ 人工裁決（機器不得覆寫、否決是墓碑）＋ 圖瀏覽 ＋ 閱讀器與點註 ＋ 本機保存」
（**限本次檢索範圍**）。**但下面五條把「差在哪」的講法改掉了** —— 有三條原本寫的差異已經不成立。

### 一、更正：「AI 研究助理無圖」不成立　`A · 09-28`

Gemini Notebook（原 NotebookLM）有**心智圖**：把上傳的來源畫成分支圖，點節點在聊天裡提問；
要重生成得先刪掉整張（官方說明 `support.google.com/notebooklm/answer/16212283`）。
09-06 查的是另一頁說明（`answer/16269187`），那一頁確實沒提圖 —— **頁查對了，範圍不夠**。

差異仍在，但要講準：它是**主題樹**（階層摘要），不是**關聯網**；節點沒有逐條引文、
不能裁決、重生成是整張重來。

### 二、更正：「台灣本地也沒有對手」不成立　`A（功能）／C（公司背景）· 09-28`

- **Heptabase**：v1.103.0（2026-08-14）的 AI Agent **會自己建立與更新白板上的連線**，
  「Break down book」把一本書或一章拆成**段落完整、附引文的白板**；經 CLI 建立的筆記
  預設標「Created by AI」；另有 MCP 與 PDF 解析（官方 changelog）。
  創辦團隊是台灣人、團隊在台灣（YC 2022）—— **這一句來自新聞與維基百科，C 級**。
- **資策會「III 知識圖譜標記工具」**（2020 年上線）：標記三元組、自動帶入標過的節點與關聯、
  少量標記後機器自動標。09-04 列過，**現況這次沒查**（C）。

→ 讀者很可能用過 Heptabase。差異要講在它沒有的地方：**連線背後的引文找不找得到原文、
機器建的連線有沒有「待查證 → 人裁決」的狀態、否決過的會不會再被提出**。
它的「Created by AI」是同一個問題（出處）的另一種答法 —— **不是對手沒想到，是答法不同**。

### 三、「本機優先、每個任務選模型」不再是差異　`A · 09-28`

**Memorwise**（MIT，2026-04-02 建立）：Node 22／24 ＋ SQLite ＋ LanceDB、資料在單一資料夾、
**逐任務選 provider**（chat／embeddings／轉錄／TTS）、AI 抽概念畫關係圖、聊天回答附引用、
有 MCP、把匯入內容當不受信任資料（擋私網 URL）。**技術取向跟 Cyclosa 幾乎一樣，而且早五個月。**
Open Notebook（MIT，約 4 萬星）、SurfSense（桌面版、可離線）也都是本機。

→ 這幾件以後**只能寫成「做法」，不能寫成「特色」**。它們跟 Cyclosa 的差別：沒有研究代理
（只收你給的來源）、圖是概念層（README 沒寫邊的出處）、產物是摘要／測驗／podcast
（Cyclosa 刻意不產生報告）。

### 四、「LLM 圖譜函式庫沒有 UI」部分不成立　`A · 09-28`

- **LightRAG** 有 WebUI（2024-11 起）：上傳、Sigma.js 圖、查詢；2025-03 起有引用
- **Neo4j LLM Graph Builder**（Apache-2.0）：線上與本機（docker compose）；實體與關係
  **連回原始 chunk**；可自訂 schema、有重複節點偵測與後處理清理
- **Kotaemon**（Apache-2.0）：引用可在瀏覽器內的 PDF 上反白、GraphRAG 索引

→ **仍然成立的是「無人工裁決」**：三者都是抽完就入圖，出處到 chunk（段落）層級，
沒有「待查證／已確認／已否決」與墓碑。

### 五、「機器提議、人裁決」有成熟前例 —— 差異要講在細節　`A · 09-28`

- **INCEpTION**（Apache-2.0，UKP Lab，2018 起）：推薦器邊用邊學、主動學習先問最沒把握的，
  **「你接受之前什麼都不會進資料」**
- **CleanGraph**（MIT，2024 論文）：人工修正抽出三元組的網頁工具（repo 2023 後沒更新）
- **GRACE**（arXiv 2609.04442，**2026-09-03**）：把 LLM 回答拆成原子主張、放進加權**二部圖**
  對照可信先驗，分成已佐證／被反駁／邊界；用 Return on Attention 決定哪些值得送專家；
  驗過的變成新證據錨點，知識庫逐輪擴大

→ Cyclosa 的 ADR-0005（二部圖、每條邊必帶出處）是 **2026-09-06** 提交的 ——
**比 GRACE 晚三天，設計紀錄裡沒有引用它**，是各自到達相近的結構；而且兩邊的二部圖連的東西不同
（GRACE：主張↔先驗；Cyclosa：文件↔實體）。**不能寫「首創人機協作的知識圖譜」**。
能講的差異：墓碑（否決過的不再提，除非帶新出處）、**用你自己的裁決回頭校準可信度**、
**引文在匯出時重新驗**、研究流程的三道閘門、快照不可變。

### 仍然成立、這次有重新確認的

- **深度研究代理的產物是報告。** Gemini Deep Research 先產生規劃、可以「Edit plan」再
  「Start research」—— **這是閘門一的直接前例，借的是概念** —— 終點仍是報告（A）。
- **自動連結 ≠ 具名關係。** Recall 的連結是共同關鍵詞（A）、InfraNodus 的邊是詞的共同出現（A）——
  對應 Cyclosa 的「共同提及」層。
- **調查工具**：Maltego 的 transform「從一個實體往外擴」是「從一個點出發」最早的形狀（A）；
  **Hunchly 自動替每個瀏覽過的頁面記下網址、時間、雜湊並打包成證據包**（A）——
  最接近擷取管線＋證據包的前例，但沒有關聯圖。
- **System**（system.com）：邊是研究論文裡的統計關聯，全程有出處（A）——
  同樣重視出處，但語料是它的，不是你的。

### 模組對照：誰解過、借什麼、差在哪

| Cyclosa 模組 | 前例與做法 | 授權 | 借什麼 | 差在哪 |
|---|---|---|---|---|
| 研究規劃（閘門一）| Gemini Deep Research：規劃 → Edit plan → 開始 | 專有 | 概念 | 規劃之後是候選清單與人手取得，不是報告 |
| 多視角方向 | STORM／Co-STORM：從相似主題歸納視角、Co-STORM 用樹狀心智圖整理 | MIT | 概念（⑥ 已借）| 方向只是路線，產物是圖 |
| 子問題成圖 | MindSearch：WebPlanner 把子查詢建成圖逐步擴展 | Apache-2.0 | 不借 | 它的圖是搜尋計畫；預設模型是中國來源 |
| 候選與取得 | Undermind（深度論文搜尋）、Elicit | 專有 | 不借 | 「拿不到」是一等公民，依你自己的紀錄判斷 |
| 擷取與保存 | Hunchly（網址＋時間＋雜湊、證據包）、ArchiveBox | 專有／MIT | 概念 | 快照直接進研究圖；robots 與節流在同一層 |
| 抽取建圖 | Neo4j Graph Builder（連回 chunk、schema、去重）、LightRAG、GraphRAG | Apache-2.0／MIT | 概念 | 出處到**字元區間**，找不到就沒有這條邊 |
| 人工裁決 | INCEpTION（接受前不入資料）、CleanGraph、資策會標記工具 | Apache-2.0／MIT／— | 概念 | 墓碑、裁決比例回頭校準、機器不得覆寫 |
| 主張分級 | GRACE（二部圖、三類、RoA）| 論文 | 概念（RoA）| 你自己的語料、閱讀器、不可變快照 |
| 圖瀏覽 | Obsidian ＋ InfraNodus 外掛（3D、缺口）、Recall、Heptabase 白板 | 專有／**AGPL** | 概念 | 邊有層別與查證狀態；3D 只瀏覽 |
| 閱讀與點註 | Heptabase、Kotaemon（PDF 反白引用）、Hypothesis／Zotero（W3C）| 專有／Apache-2.0／AGPL | 規格與概念 | 錨在不可變快照 |
| 本機與模型分工 | Memorwise、Open Notebook、SurfSense、LightRAG（四種角色）| MIT／MIT／混合／MIT | — | **不是差異**（見三）|

### Stage 21–24 可以直接參考、不必重想的設計

1. **「整理」的重複實體候選**：Neo4j Graph Builder 用**屬性文字距離（預設 5）＋相似分數（預設 0.97）**
   兩道門檻找重複節點，再交給清理模型。Cyclosa 的實體合併已經是人按了才合，缺的是**候選怎麼來** ——
   先照這兩道門檻產生候選，**數字要自己量**（Q1 那一類的教訓）。
2. **待查證佇列先看哪一條**：GRACE 的 Return on Attention —— 「不確定 × 重要」超過驗證成本才送人看。
   Cyclosa 的佇列現在不排序；可以借這個判準排順序，**不借它的自動分類**（機器不得決定）。
3. **抽取用非思考模型**：LightRAG 的 README 對抽取角色「強烈建議」關掉思考模式 ——
   跟 2026-09-09（v0.10.5）量到的 `think: false`（八個模型裡七個翻盤）是**各自獨立的同一個結論**，
   可以當 `chat-choice.md` 的外部佐證。
4. **「機器建的」要看得見**：Heptabase 讓 CLI 建立的筆記預設標「Created by AI」。
   Cyclosa 有 `origin` 欄位，Stage 22 建圖時確認畫面上分得出來。

### 授權盤點（新增，A 級，GitHub API 2026-09-28）

| 授權 | 專案（最後 push）|
|---|---|
| MIT | LightRAG（2026-09-28）、Open Notebook（2026-09-27）、Memorwise（2026-06-09）、STORM（**2025-09-30**）、CleanGraph（2023-08-10）|
| Apache-2.0 | Neo4j LLM Graph Builder（2026-09-16）、Kotaemon（2026-07-14）、INCEpTION（2026-09-28）、MindSearch（**2025-07-04**）|
| **AGPL-3.0 · 只讀概念** | **InfraNodus Obsidian 外掛**（2026-08-04）、**Reor**（已封存）—— 兩個都是新增的紅線 |
| **混合** | **SurfSense**：API 回 `NOASSERTION`，讀 `LICENSE` 才知道 `surfsense_backend/app/proprietary/` 是 **Business Source License 1.1**、其餘 Apache-2.0 —— 跟 Zotero 同一個教訓的第二個實例 |

### 相依授權重盤（2026-09-28，讀 `node_modules` 裡每個套件的 `package.json`）

321 個套件：MIT 244、ISC 26、Apache-2.0 19、BSD-2-Clause 19、BSD-3-Clause 10、MPL-2.0 2、BlueOak-1.0.0 1。
**GPL／AGPL／BSL／未宣告：0。** MPL-2.0 是 `lightningcss`（與它的 Windows 二進位檔），
由 `vite` 帶進來、只在建置時用；BlueOak 是 `minimatch`（`eslint` 帶進來，寬鬆授權）。

### 這一次沒有涵蓋的

| 沒查 | 為什麼 |
|---|---|
| OpenAI／Claude／Perplexity 的深度研究 | 跟 Gemini 同一種形狀（規劃 → 蒐集 → 報告），這次只查 Gemini 當代表 |
| Kosmik、Scrintal、Tana、Capacities、TheBrain | 閉源白板與物件筆記；Heptabase 已代表這一類 |
| Cofacts.ai 的產品頁 | 首頁是 JS 殼（抽出 138 字），只有搜尋摘要（C）|
| Taiwan AI Labs、資策會工具的現況 | 只有搜尋結果與新聞（C）|
| GRACE 的程式碼與授權 | 論文頁只給「code available」連結，沒有追 |
| Memorwise 的圖有沒有逐條引文 | README 只寫「AI-extracted concepts」，要裝起來看才知道 |

---

## 結論：七個賽道，沒有一個涵蓋這個組合（2026-09-06；**部分已由上一節更正**）

要找的組合是：**主動擴展 ＋ 每條關聯帶出處 ＋ 圖瀏覽 ＋ 內建閱讀器 ＋ 本機保存 ＋ 可續接**。

| 賽道 | 代表 | 缺什麼 | 級別 |
|---|---|---|:--:|
| **筆記圖** | Obsidian、Logseq、Heptabase、Scrintal、TheBrain | 線**全靠人手動連**、型別扁平、無爬取、無出處 | C（09-04）|
| **AI 研究助理** | **Gemini Notebook**（原 NotebookLM）、Anara、Elicit | 綁單一模型、**來源數上限**、~~無圖~~ **有心智圖（主題樹），沒有帶引文的關聯網**（09-28 更正，見一）、無本機保存 | **A（09-06）** |
| **調查／OSINT** | Aleph（**日落**）、Datashare、Maltego、i2、Linkurious | 要 Docker＋Elasticsearch 或商業授權、**LLM 不主動擴展**、繁中弱 | **A（09-06）** |
| **文獻圖譜** | Connected Papers、ResearchRabbit、Litmaps、Inciteful | **只吃論文**、關係型別不可自訂 | C（09-04）|
| **LLM 圖譜函式庫** | GraphRAG、LightRAG、cognee、Graphiti | ~~是函式庫不是應用：無 UI~~（LightRAG 有 WebUI、Neo4j Graph Builder 是應用，09-28 更正，見四）、無閱讀器、**無人工裁決** | **A（09-06）** |
| **保存／稍後讀** | ArchiveBox、SingleFile、Karakeep、Linkwarden | **沒有關聯圖**，也不做擴展 | **A（09-06）** |
| **深度研究代理** | STORM、GPT-Researcher | **輸出是一篇報告**，不是可累積、可續接、可再展開的結構 | **A（09-06）** |

~~台灣本地也沒有對手~~（資策會的「III 知識圖譜標記工具」是面向企業的**標記工具**）。**C 級，09-04。**
**09-28 更正**：Heptabase（台灣團隊）2026-08 起有會自己建白板連線、附引文拆書的 AI Agent，見上面的二。

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
