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
