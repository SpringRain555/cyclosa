# 維護筆記

**這一份是「症狀 → 哪個檔 ＋ 哪條測試守著」的查找表。**
任何獨立的規則都不寫在這裡 —— 規則有它自己的權威位置，這裡只放指路。

> **這一份在 2026-09-07 之前是空的，而那是刻意的**：
> 它需要「症狀」與「測試」，而 Stage 5 之前兩者都不存在。
> 現在有 207 個測試了，所以它有東西可寫。

---

## 建置與啟動

| 症狀 | 看哪裡 | 誰守著 |
|---|---|---|
| 雙擊啟動器沒反應／閃退 | `Launch.ps1`。它每一步都印字，看它停在哪一步 | —— |
| 「連接埠 7433 被別的程式佔用」 | `Launch.ps1` 的 `Get-PortOwner`。**它會分辨是不是 Cyclosa 自己**（打 `/healthz` 看 `app` 欄）| ADR-0020 |
| 關掉視窗之後 7433 還在被佔用 | `Launch.ps1` 是**直接跑 `node dist\main.js`**，不透過 `npm.cmd` —— 有人改回去的話就會這樣 | `docs/lessons.md`（`rubricator` 踩過）|
| `npm ci` 之後型別爆一堆 | 多半是 TypeScript 被升到 6.1 以上。**`typescript-eslint` 的 peer 是 `<6.1.0`** | `environment/versions.md` |
| build 完跑起來卻說找不到 migration | `.sql` 不是 `tsc` 會複製的東西 —— `tools/build/copy-assets.mjs` 負責搬 | 那個檔案自己的註解 |

## 資料與啟動狀態

| 症狀 | 看哪裡 | 誰守著 |
|---|---|---|
| 專題清單是空的，但明明建過 | **先看它是不是錯誤畫面而不是空清單。** 四種指標檔失敗各有各的訊息 | `tests/e2e/case-flow.test.ts` |
| 「找不到記錄資料位置的檔案」 | `src/infrastructure/fs/paths.ts` 的 `resolveDataRoot` | 同上 |
| 專題資料夾名字跟輸入的不一樣 | `src/domain/case/slug.ts`。中文保留原樣，但結尾的點與空白會被拿掉（Windows 會靜默吃掉它們）| `tests/domain/slug.test.ts` |
| 建專題失敗之後留下一個空資料夾 | `case-service.ts` 的 `createCase` 有 `finally` 清理 —— 那段被改掉的話就會留 | —— |
| 「這個專題被較新版本寫過」 | `database.ts` 的 `SUPPORTED_SCHEMA_VERSION` 與 `PRAGMA user_version` | `tests/infrastructure/db-constraints.test.ts` |

## 匯入與擷取

| 症狀 | 看哪裡 | 誰守著 |
|---|---|---|
| 匯入很慢（每一項要等三秒）| **那是對的。** 同網域間隔 3 秒是不可違反的規則，不是設定 | `tests/domain/ingest-rules.test.ts`、`tests/e2e/ingest-flow.test.ts`（從伺服器端量）|
| 某一個網址被跳過，說 robots 不准 | `domain/ingest/robots.ts`。**命中哪一條規則會記在 `run_item.code` 與細節裡** | `tests/domain/robots.test.ts` |
| 整批突然停了 | 對方回 429／503 → **立即停且不重試**。已寫入的保留，其餘標「已取消」 | `throttle.ts` 的 `isBackOffSignal` |
| 抓了一個網域卻沒去問 robots | 不該發生。`Crawler` 的 gate **先問 robots 再排節流**，而且**轉址每一跳都重問** | `fetcher.ts` 的 `MAX_REDIRECTS` 那一段 |
| 同一個網址匯入兩次長出兩個節點 | `item.requested_url` 的唯一索引；內容層另外看 `sha256` | `tests/e2e/ingest-flow.test.ts` |
| 作業紀錄裡有一列沒有對應的節點 | **正常。** 重複、robots、取消都不會有 `item` —— 這正是 `run_item` 存在的理由 | `data-model.md` |
| 正文抽出來是空的／很爛 | 先看**抽取信心標記說了什麼理由**。門檻在 `extract-confidence.ts`，量測在 `research/extraction-confidence.md` | `tests/domain/extract-confidence.test.ts` |
| 中文內容查不到 | 先看 `item.lang`。判成拉丁語系的話只會進 FTS5，而那等於沒有索引 | `multilingual.md`、`tests/domain/search-tokenize.test.ts` |
| 語言判成一個完全不相干的 | **`franc` 判不出來時不會說判不出來。** 兩道證據閘門在 `extract/language.ts` | `docs/lessons.md` |
| 改了抽取邏輯，舊的 `derived/` 還在 | `EXTRACTOR_VERSION` 沒有 +1。檔名帶版本，就是為了這件事 | `case-files.ts` |
| 一鍵啟動打開的是舊版程式 | `Launch.ps1` 會比對 `/healthz` 的版本與 `package.json`，**不一樣就停下來說** | `docs/lessons.md` |

## 圖與裁決

| 症狀 | 看哪裡 | 誰守著 |
|---|---|---|
| 確認過的關聯又變回待查證 | **這是最嚴重的一種。** `machineMayUpdateStatus` 與 `trg_edge_human_row_immutable` | `tests/domain/edge-state.test.ts`、`tests/infrastructure/db-constraints.test.ts` |
| 否決過的關聯一直重新出現 | 墓碑檢查（`tombstone.ts` 的 `evaluateProposal`）。**例外只有「帶著新的 `item`」** | `tests/domain/tombstone.test.ts` |
| 可信度顯示成小數 | 不應該發生。連續分數只走 `tierOf`，UI 只拿等級 | ADR-0017 |
| 「出處 5 筆」但感覺不對 | 要同時看**獨立來源數** —— 5 筆可能只有 2 個獨立來源 | `tests/domain/confidence.test.ts` |
| 校準比例是「樣本不足」 | 樣本下限 30 條，這是刻意的 | ADR-0017 |

## 文件與治理

| 症狀 | 看哪裡 | 誰守著 |
|---|---|---|
| `AGENTS.md` 與 `CLAUDE.md` 內容不同 | **不要手動改 `AGENTS.md`。** 跑 `tools\Sync-AgentDocs.ps1`（本文取自 `CLAUDE.md`）| `Verify.ps1` 會跑 `-Check` |
| `Verify.ps1` 說有圖過期 | 改過某段 mermaid。跑 `tools\diagrams\Render-Diagrams.ps1` —— 只有變動的那幾張會重算 | `manifest.json` 的 SHA-256 |
| 加了一個錯誤碼之後測試紅了 | **三邊要一起改**：`codes.ts`、`error-codes.md`、`i18n/zh-TW.ts` | `tests/guards/error-codes.test.ts` |
| 在元件裡寫了中文就紅 | 全部走 `web/src/i18n/zh-TW.ts` | `tests/guards/i18n-literals.test.ts` |
| 在 `domain/` import 東西就紅 | `domain/` 零 I/O；`domain/graph/` 更嚴，**連 `domain/` 的其他資料夾都不能 import** | `tests/guards/layering.test.ts`、`domain-graph-deps.test.ts` |
| prettier 想重排 `docs/` 的 Markdown | **不該發生** —— `.prettierignore` 裡有 `*.md`。理由寫在那個檔案裡 | —— |

## 兩個「看起來像 bug 但不是」

1. **`Start Cyclosa.cmd` 開了瀏覽器卻沒起新的 server。**
   那是單一實例：7433 上已經有一個 Cyclosa，所以它開既有的那一個（ADR-0020）。

2. **一批匯入有幾項失敗，但 run 標的是「部分失敗」而不是「失敗」。**
   那是設計。40 個 URL 有 3 個 404，其餘 37 個的內容不該跟著消失 ——
   **只有一個都沒成功才是 `failed`**（`settleRun`）。

## 加一條新的守門測試時

**先寫一個會違反它的東西，確認測試真的會紅，再刪掉。**

Stage 5 的四條守門各注入過一個真實違規驗證（例如在 `domain/case/state.ts` 加
`import { readFileSync } from 'node:fs'`），六個案例全部命中。

> **一條不會紅的守門測試，跟一條不存在的守門測試長得一模一樣。**
> 這個專案已經踩過一次同型的坑（`docs/lessons.md` 的 opt-in 檢查那一條）。
