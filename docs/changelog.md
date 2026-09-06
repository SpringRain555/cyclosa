# Changelog

**記「那一版改了什麼、為什麼」。** 未來的計畫在 `roadmap.md`，
踩到什麼坑在 `lessons.md`。

**還沒有版本。** 這個專案目前一行程式都沒有，`package.json` 也還不存在，
所以沒有版號可記。第一次跑得起來的時候從 `v0.1.0` 開始。

在那之前，做了什麼看 git log 與 `roadmap.md` 的 Stage 表。

---

## 未發行

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

### 2026-09-06　Stage 4：四張圖的 SVG

跑 `tools\diagrams\Render-Diagrams.ps1`，**7 段 mermaid → 7 個 SVG**
（`overview` 2、`state-machines` 4、`data-model` 1）＋ `manifest.json` 的 SHA-256。
第一次執行讓 `npx` 下載了 mermaid-cli 與它帶的 Chromium。

兩件驗過的事：

- **加上原本漏掉的 `note`**（「機器永遠不得覆寫人工判定」）之後重跑，
  **只有那一張重算，其餘六張 skip** —— SHA-256 的增量判斷是對的。
- **逐段比對 mermaid 標籤有沒有真的出現在 SVG 裡**：67 個標籤、0 缺，
  並用「故意加一個 SVG 裡沒有的標籤」確認那個比對真的會紅。
