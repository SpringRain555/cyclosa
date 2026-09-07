# Changelog

**記「那一版改了什麼、為什麼」。** 未來的計畫在 `roadmap.md`，
踩到什麼坑在 `lessons.md`。

目前是 **v0.1.0**（2026-09-07，Stage 5 收尾）。

---

## v0.1.0 —— 2026-09-07　Stage 5：最小可跑

**第一個跑得起來的版本。** 雙擊 `Start Cyclosa.cmd` → 瀏覽器開起來 → 建一個空專題。
**能做的只有這些** —— 匯入、閱讀器、圖、擴展、筆記、檢索都還沒有。

- **工具鏈**：`package.json`（Node `>=24 <25`）、三份 tsconfig、vite 8、vitest 5、
  eslint 10 flat config、prettier。**TypeScript 釘在 `~6.0`** ——
  `typescript-eslint` 8.69 的 peer 是 `<6.1.0`，所以已經是 latest 的 TS 7 不能用
- **四層骨架** ＋ `web/` 前端。`domain/` 零 I/O，`domain/graph/` 零依賴
- **schema v1**（`node:sqlite`）：11 張表、18 個索引、**3 條 trigger**。
  那兩條「由資料庫層守著」的約束（已確認要有出處、`origin='human'` 的列不可改）
  現在真的由 trigger 守著，而且有測試證明它們會擋
- **指標檔的四種失敗各有各的訊息** —— 「指標檔在哪、它指到哪、那個路徑怎麼了」
  是同一句話裡的三件事（REQ-0001）
- **一鍵啟動**：`Start Cyclosa.cmd` → `Launch.ps1`。單一實例（埠被自己佔用時
  開既有的那一個）、產物比原始碼舊時自動重建、關掉視窗就結束
- **`Verify.ps1`**：lint ＋ prettier ＋ 兩套型別 ＋ 134 個測試 ＋ 兩份 agent 檔比對
  ＋ 圖表是否過期。`-Report` 產出**去識別化**的環境快照

**四條守門測試，每一條都注入真實違規驗過會紅**（六個案例全部命中）：
分層、`domain/graph` 零依賴、i18n 中文字面值（**用 AST，所以中文註解不會誤報**）、
錯誤碼三邊對照。

三件順手補掉的：

- **`tools/Sync-AgentDocs.ps1`** 進版控 —— ADR-0013 的代價那一節記著
  「產生器不在 repo 裡，所以保證平級的是驗證器而不是產生流程」，那條現在處理掉了
- **`operations/maintainer-notes.md`** 寫了 —— 它需要「症狀」與「測試」，
  而 Stage 5 之前兩者都不存在
- **`.prettierignore` 排除所有 `.md`** —— prettier 會把文件的窄表格撐成兩百字元寬、
  把 `*強調*` 換成 `_強調_`，兩者都讓 diff 變得無法閱讀，而 diff 正是這些文件被 review 的方式

**一個實作時發現的文件錯誤**：`api-contract.md` 把 `*_DUPLICATE` 歸在 HTTP 400，
但「名稱重複」不是請求格式錯，是**跟既有狀態衝突** —— 改成 409，文件與程式一起改。

---

## 未發行（Stage 5 之前）

### 2026-09-05　Stage 1：治理骨架

建立 repo。README／AGENTS／CLAUDE（兩份 agent 檔由同一份本文產生）、MIT 授權、
`.gitignore`／`.gitattributes`／`.githooks/pre-commit`、`.claude/settings*.json`，
以及 repo 外的資料根目錄。**沒有任何程式。**

### 2026-09-06　Stage 2：文件六區

`architecture/`（總覽＋分層、狀態機、資料模型，四張圖的 mermaid 正本）、
`environment/`（怎麼建與每條版本界線的理由）、`research/`（2026-09-04 的市場調查
與授權盤點、還沒有答案的問題）、`roadmap.md`、`lessons.md`、這一份、`index.md`。

三件值得記在這裡的：

- **`research/index.md` 明寫那次調查沒有留 query log**，並禁止事後補一份 ——
  憑印象重建的查詢紀錄比沒有更糟，它看起來像證據。
- **`roadmap.md` 從第一天就列出完整的 Stage 表**。那是從 `rubricator` 學來的：
  它的階段編號散在註解裡、沒有任何一份文件列全，於是沒有人能照著推進。
- **每一份文件都分「✅ 已經有／⬜ 打算有」**，而且明白寫著現在一行程式都沒有。
  同樣是從 `rubricator` 學來的：它的文件用現在式描述了一整套不存在的指令。

### 2026-09-06　Stage 3：決策與需求

**14 份 ADR（0001–0014）與 8 份 REQ（0001–0008）。** 每份 ADR 的「代價」與
「什麼情況要重新考慮」都不留空白 —— **沒有代價的決定通常代表還沒想清楚**，
而沒有觸發條件的決定沒辦法被推翻。

四件連帶的事：

- **`open-questions.md` 的 Q5 搬進 ADR-0014 並從那份文件移除**（那份不是 append-only）。
  答案是觸發條件本身：**兩邊的複本已經分岔，而那個分岔造成了一個 bug** ——
  不是「兩個專案都用到」。文件底下留了一張「已經搬走的」表，
  否則下一個人會以為那個問題從來沒被問過。
- **兩份 agent 檔補上 `<!-- agent-doc:sync-notice -->` 標記。**
  寫 ADR-0013 時才發現 `agent-doc-content-drift` 是 **opt-in** 的
  ——沒有標記它根本不啟動，而三個專案一個都沒有標記。見 `lessons.md`。
- `versions.md` 的 Playwright 升級路徑本來寫「ADR（尚未撰寫）」，改成指向 REQ-0003。
- `overview.md` 的 ADR-0014 引用補上實際的觸發條件。

### 2026-09-06　Stage 4.5：設計稿回寫 ＋ 市場調查重跑

**這一階段不在原本的計畫裡。** 要開始寫程式之前重讀整個專案，發現兩個洞。

**洞一：Stage 0 的 UI 設計稿裡有 16 條決定從來沒有回寫進 `docs/`**，
其中 3 條與現有文件牴觸 —— 最嚴重的是關聯狀態機（文件 5 條轉移、已確認是終點；
設計稿 6 條，允許撤回與改判，而且它自己寫著「原本缺這條」）。
**文件比設計稿晚寫，卻比它舊**（記進 `lessons.md`）。

逐條與使用者確認之後全部採用，回寫成：

- **ADR-0015** 關聯四層與獨立來源數 · **ADR-0016** 已否決是墓碑 ＋ 稽核紀錄 ·
  **ADR-0017** 可信度三段等級與裁決校準 · **ADR-0018** 顏色與記號（含 CVD 實測數字）·
  **ADR-0019** PDF 頁碼與圖片矩形錨點 · **ADR-0020** 埠 7433 與單一實例
- 改 `state-machines.md`（6 條轉移、墓碑、已讀是正交旗標不是狀態）、
  `data-model.md`（`edge.layer`、`edge_audit`、`item.read_at`、投影三段、向量要記模型）、
  `overview.md`（補 `domain/search/` 與 `infrastructure/index/`）
- 新增 7 份架構文件：`ui-workflows`／`graph-view`／`api-contract`／`storage-layout`／
  `error-codes`／`glossary`／`multilingual`
- 新增 `operations/release-checklist.md`（26 項，**每項標了「現在能不能查」**）。
  `maintainer-notes.md` 仍然留白 —— 還沒有症狀也還沒有測試，理由沒變

**洞二：Stage 表裡沒有任何一階段交付「檢索」**，而 ADR-0009 與 REQ-0007
已經把整套雙軌索引設計完了。補上 **Stage 12（檢索）** 與 **Stage 13（規模驗收與公開前自檢）**。

**市場調查提前重跑**（觸發條件是「要開始實作」與「要加 24 個依賴」，不是時間到）。
從第一個查詢就記 `query-log.md` ＋ `sources/manifest.jsonl`（**55 列，52 列有 SHA-256**，
沒有雜湊的 3 列寫明原因）。四件值得記的：

- **三條授權更正**：Zotero 用 GitHub API 查回 `NOASSERTION`（要讀 `COPYING` 才看得到
  AGPL-3.0）—— **2026-09-04 那份宣稱的方法問不出它宣稱的答案**；
  Linkwarden 是 AGPL 卻不在紅線名單上；`cosmos.gl` 的 repo 路徑是 `cosmosgl/graph`
- **Aleph 已日落**（開源版維護到 2025-12-31，轉向專有的 Aleph Pro）。
  這個賽道真正還活著的可借部分是 `followthemoney`
- **`followthemoney` 的 70 個 schema 裡有 `Mention` 與 `Similar`** ——
  獨立於我們的設計，收斂到同一個「關聯要分層」的結論
- **一條改了資料模型的發現**：嵌入模型換掉之後舊向量全部作廢，
  **而餘弦相似度照樣算得出數字** —— 所以 `vector` 表必須記 `model` ＋ `dim`，不符就拒絕比對

順帶更正 `versions.md`：**「Vite 8 要 Node 24」是假的**（實際是 `^20.19.0 || >=22.12.0`），
Node 下界現在只剩 `node:sqlite` 一條腿；TypeScript 卡在 `~6.0`
（`typescript-eslint` 8.69 的 peer 是 `<6.1.0`，所以已經 latest 的 TS 7 不能用）。

### 2026-09-06　Stage 4：四張圖的 SVG

跑 `tools\diagrams\Render-Diagrams.ps1`，**7 段 mermaid → 7 個 SVG**
（`overview` 2、`state-machines` 4、`data-model` 1）＋ `manifest.json` 的 SHA-256。
第一次執行讓 `npx` 下載了 mermaid-cli 與它帶的 Chromium。

兩件驗過的事：

- **加上原本漏掉的 `note`**（「機器永遠不得覆寫人工判定」）之後重跑，
  **只有那一張重算，其餘六張 skip** —— SHA-256 的增量判斷是對的。
- **逐段比對 mermaid 標籤有沒有真的出現在 SVG 裡**：67 個標籤、0 缺，
  並用「故意加一個 SVG 裡沒有的標籤」確認那個比對真的會紅。
