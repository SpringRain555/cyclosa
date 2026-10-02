# 維護筆記

**這一份是「症狀 → 哪個檔 ＋ 哪條測試守著」的查找表。**
任何獨立的規則都不寫在這裡 —— 規則有它自己的權威位置，這裡只放指路。

> **這一份在 2026-09-07 之前是空的，而那是刻意的**：
> 它需要「症狀」與「測試」，而 v0.1.0 之前兩者都不存在。
> 2026-09-07 寫這一段的時候有 207 個測試，所以它有東西可寫（現在的數字問 `npm test`，不寫在這裡）。

---

## 建置與啟動

| 症狀 | 看哪裡 | 誰守著 |
|---|---|---|
| 雙擊啟動器沒反應／閃退 | `tools\Launch.ps1`。它每一步都印字，看它停在哪一步 | —— |
| 「連接埠 7433 被別的程式佔用」 | `tools\Launch.ps1` 的 `Get-PortOwner`。**它會分辨是不是 Cyclosa 自己**（打 `/healthz` 看 `app` 欄）| ADR-0020 |
| 按了「結束 Cyclosa」之後 7433 還在被佔用 | `Launch.ps1` 是**直接跑 `node dist\main.js`**，不透過 `npm.cmd` —— 有人改回去的話，砍到的是 npm 那一層 | `docs/lessons.md`（`rubricator` 踩過）|
| 啟動器視窗關掉了，server 還在跑 | **那是對的**（ADR-0025）：視窗是檢查清單不是開關。要結束用畫面右上角那顆按鈕 | ADR-0025 |
| 啟動失敗，而視窗一閃就不見 | `%LOCALAPPDATA%\Cyclosa\logs\server.log`（上一次是 `server.prev.log`）與 `server.err.log`（v0.24.3 起；載入失敗的堆疊只在這裡），或 `.\tools\Launch.ps1 -Foreground` | ADR-0025 |
| 畫面說「連不到 Cyclosa 的伺服器」，而沒有人按結束 | 伺服器自己停了。`server.log` 最後幾行：「程式因為一個沒接住的錯誤而結束」＋ 堆疊 → JS 的錯；只有「行程結束 exitCode=…」→ 有人呼叫了 `process.exit`；**兩行都沒有** → 看 `server.err.log`（原生層的 assert，例如 libuv 的 `UV_HANDLE_CLOSING`）與日誌旁邊的 `report.*.json`（V8 fatal error）；**全部都空** → 被外面結束的 | `shared/crash-trace.ts`、`tests/shared/crash-trace.test.ts` |
| 建置明明成功，啟動器卻說「建置失敗」 | 原生指令的 stderr 被包成 ErrorRecord。**判準是離開碼** —— 走 `Invoke-Native` | `docs/lessons.md` 2026-09-09 |
| `npm ci` 之後型別爆一堆 | 多半是 TypeScript 被升到 6.1 以上。**`typescript-eslint` 的 peer 是 `<6.1.0`** | `environment/versions.md` |
| build 完跑起來卻說找不到 migration | `.sql` 不是 `tsc` 會複製的東西 —— `tools/build/copy-assets.mjs` 負責搬 | 那個檔案自己的註解 |

## 檢索

| 症狀 | 看哪裡 | 誰守著 |
|---|---|---|
| 中文兩個字查不到 | bigram 索引沒寫進去。**索引是匯入時寫的** —— 舊資料要跑 `POST …/rebuild` | `tests/e2e/search-flow.test.ts` |
| 中文頁面裡的英文／學名查不到 | 同上，而且**那一條是 2026-09-09 才加的**（CJK 的非 CJK 片段進 FTS）。舊索引沒有那些列 | ADR-0009 的補記 |
| 結果裡有明顯不相干的東西 | **那是 bigram 跨詞誤中**，而它們應該被標成「可能是誤中」並排在後面。沒有被標＝正文讀不到，看 `derived/` | `domain/search/query.ts` |
| 搜尋很慢 | 候選上限 400、驗證上限 60（`search-service.ts`）。慢多半是**一次讀 60 份正文**，不是 SQL | `environment/performance.md`（5 萬筆實測 42 ms）|
| 語意檢索要好幾秒 | **那是實際成本**（5 萬筆 2.2 秒）—— 2560 維每條 10 KB，掃全表。降段數救不了 | ADR-0028 |
| 語意檢索要**幾十秒** | 那不是實際成本，那是 schema v7 之前的樣子（缺 `(model, dim, id)` 索引）。**確認 `PRAGMA user_version` 是 7** | migration `007` 的註解 |
| 摘要上色的位置不對 | `matchStart` 是伺服器算的，而摘要壓過空白 —— 校正在 `offsetsAfterSquash` | `tests/domain/search-query.test.ts` |

## 關聯圖

| 症狀 | 看哪裡 | 誰守著 |
|---|---|---|
| 工具列的節點數顯示 `16272+` | **那是下界，不是壞掉。** 走訪走到硬上限 8,000 就停了 | ADR-0029、`tests/infrastructure/traverse-cap.test.ts` |
| 2 跳查詢要半秒多 | **那是實際成本**（1,900 個節點 ＋ 7,700 條線）。拆解在 `environment/performance.md` | ADR-0029 |
| 打開關聯圖分頁要一秒 | `defaultFocusId` 要對整張 `edge` 表做兩次 `GROUP BY` 才選得出「連得最多的那一個」 | 沒有預算，量測有記 |
| 想量 fps | 網址加 `?fps=1`，左上角出現讀數 | `release-checklist.md` D9 |

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
| 匯入很慢（同一個網域每一項要等幾秒）| **那是對的。** 同網域間隔是設定值（預設 3 秒），用 `CYCLOSA_FETCH_INTERVAL_MS` 調，**小於下限會被夾住** —— 數字在 `domain/ingest/throttle.ts`，理由在 `fetch-policy.md` | `tests/domain/ingest-rules.test.ts`、`tests/application/fetch-policy.test.ts`、`tests/e2e/ingest-flow.test.ts`（從伺服器端量）|
| 某一個網址被跳過，說 robots 不准 | `domain/ingest/robots.ts`。**命中哪一條規則會記在 `run_item.code` 與細節裡** | `tests/domain/robots.test.ts` |
| 某一個網域的項目全部記成「對方限流」| 對方回 429／503，照 `Retry-After` 等過、再試兩次還是一樣 → **這一輪不再碰那個網域**，其他網域照跑。過一段時間重跑那幾項。**整批停下來只會是有人按了取消** | `tests/infrastructure/crawler-backoff.test.ts`、`throttle.ts` 的 `backOffDelayMs` |
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
| **關聯圖是空白的** | 依序看三件：`cooldownTicks`／`cooldownTime` 還是不是無限大、`link` 力是不是被設成 `null`（要留著、強度 0）、有沒有人加回 `numDimensions()`。**三件的症狀都是「圖不動」而不是錯誤訊息** | `GraphView.vue` 開頭的註解、ADR-0007 的補記 |
| 圖上只有一個孤零零的點 | 焦點落在沒有關聯的節點上。`defaultFocusId` 應該回**連得最多的**那一個 | `docs/lessons.md` |
| 畫面說「還沒有任何關聯」但明明有 | 判斷式要問 `totalEdgeCount`（整個專題），**不是這一屏的 `edges.length`** | `CaseGraphView.vue` 的註解 |
| 線中點多了意義不明的小方塊 | 只有**投影出來的**共同提及線才有方塊（`via` 有值）。實體已經是節點時那條邊是普通等寬線 | `tests/domain/render-rules.test.ts` |
| 相似度線也畫成琥珀虛線 | 查證狀態的畫法**只套用在 `named` 層**。非 `named` 的 `status` 欄沒有意義 | `render-rules.ts` 的 `edgeLineFor`、open-questions Q6 |
| 標籤大小不對 | `objects.ts` 的 `buildLabel` 從節點邊長回推縮放；語意縮放的兩個門檻從像素回推 | `render-rules.ts` 的 `LABEL_DISTANCE` 註解 |
| 同一批資料兩次打開長得不一樣 | 節點順序沒有排序。`d3-force-3d` 本身是確定性的（種子固定的 LCG），**不穩定的是餵進去的順序** | `GraphView.vue` 的 `startLayout` |
| 圖上一條線都沒有，而專題確實有關聯 | **匯入不產生關聯**（由研究建圖抽取）。要看四種畫法用 `tools/dev/seed-graph.ts` | `tools/dev/graph-fixture.ts` |
| 合成資料上的可信度跟真實資料算出來的不一樣 | **不該發生。** `graph-fixture.ts` 結尾走 `recomputeConfidence`，跟真實寫入路徑同一支 | `tests/e2e/adjudication-flow.test.ts` |
| 多了一個獨立來源，可信度卻沒動 | 先看那條邊**有沒有被人碰過**（`machineMayUpdateStatus`）。碰過就不動，那是規則不是 bug | `tests/e2e/adjudication-flow.test.ts` |

## 研究與建圖

| 症狀 | 看哪裡 | 誰守著 |
|---|---|---|
| 規劃完卻沒開始抓 | 閘門一「照這份規劃開始」才啟動蒐集；先檢查找來源與初讀服務 | `tests/e2e/research-flow.test.ts` |
| `PROVIDER_NOT_CONFIGURED`，但設定頁上明明填了模型 | 那個模型**沒有拉下來**。`chat.probe()` 在 `/api/tags` 找不到它就當成沒設定，而設定頁會把偵測到的清單列出來 | `chat-ollama.ts` 的 `probe` |
| `PROVIDER_UNREACHABLE` | Ollama 沒開，或 `claude` 不在 PATH 上。**訊息的 `detail` 會說是打不到哪裡** | `tests/e2e/research-collect.test.ts` |
| `PROVIDER_CAPABILITY_MISSING` | **不會自動換一個弱的**（ADR-0006）。`detail.missing` 說缺哪幾樣，設定頁上也看得到 | `tests/domain/provider.test.ts` |
| 抽出來的關聯比模型講的少 | 三種可能，**每一種都會記在 `run_item.code` 或計數裡**：引文在原文裡找不到（`PROVIDER_QUOTE_NOT_FOUND`）、關係的兩端不是宣告過的實體、型別不在六個值裡 | `tests/domain/provider.test.ts` |
| 引文的位置指到別的地方 | 不該發生 —— **位置是我們自己在正文裡找的**，模型給的數字不採信 | `locateQuote`、ADR-0021 |
| `PROVIDER_SANDBOX_VIOLATION`，整批停下來 | 沙箱裡出現了放行清單以外的檔案。**那是白名單不是黑名單**，所以一個 `.csv` 也會報 | `tests/domain/provider.test.ts`、`tests/e2e/research-collect.test.ts` |
| 找來源走 OpenAI 相容 API 停手，說缺「browse」或「沒有搜尋就交回了網址」 | **那是量出來的。** 端點收了 `web_search` 工具卻沒搜（回應裡沒有完成的 `web_search_call`），或根本沒有 `/responses`；設定頁「上網搜尋」那一行寫著原因。**沒搜就交回的網址不採用**（ADR-0034）| `tests/infrastructure/agent-openai.test.ts`、`tests/e2e/research-collect.test.ts` |
| OpenAI 相容 API 的回應是空的、或設定頁說「還沒量過」而明明量過 | Responses API **不串流會回空的 `output`**（一律串流，`responses-api.ts`）；v0.24.1 之前的量測沒有 `protocol` 欄位，讀到就當沒量過、重量一次 | `tests/infrastructure/chat-openai.test.ts` 的「先走 Responses API」 |
| agent 起不來，說結束碼不是 0 | **命令有空白時不要走 shell。** `needsShell` 只對 `.cmd`／`.bat` 回 true —— `shell: true` 不會替命令那一段加引號 | `agent-claude.ts` 的 `needsShell` |
| 研究花費看起來少了 | 規劃與缺口評估計費紀錄，加上所有 `run.research_id` 對應作業的逐任務花費；沒回報的次數另外數 | `tests/tools/research-cost.test.ts` |
| 畫面說「本機執行，無金額成本」但用的是 `claude` | 那句話只在 `cost_usd = 0` 時出現。**`NULL` 是「這個模型沒有回報金額」** —— 兩者不同 | `data-model.md` |

## 證據包匯出

| 症狀 | 看哪裡 | 誰守著 |
|---|---|---|
| 匯出的引文標著「位置已移動」 | **那是設計。** `derived/` 重算過，位移平移了。引文一字不差，檔案裡兩組數字都寫 | `tests/domain/export.test.ts` |
| 匯出的引文標著「回溯不到」 | 那一份的 `derived/` 不在了，或正文裡真的找不到那一段。**檔案照樣產生**，`notice` 是 `EXPORT_EVIDENCE_MISSING` | `tests/e2e/export-flow.test.ts` |
| 匯出之後資料庫裡的位置沒變 | **那是設計。** 匯出是唯讀的 —— 把位置對回去是 `POST …/rebuild` 的事 | `tests/e2e/export-flow.test.ts` |
| 畫面上看得到的線，證據包裡沒有 | 投影出來的共同提及線**不在資料庫裡**，沒有出處可以附。檔案的「沒有匯出的」那一節會說出條數 | `tests/domain/export.test.ts` |
| 出處那一份不在選取範圍裡，但它出現在 `sources.md` | **那是設計。** 不自帶它的話，回溯的終點會落在這份檔案外面 | `tests/e2e/export-flow.test.ts` |
| 共同提及／相似度／轉載沒有排在「待查證」裡 | 它們不是主張（ADR-0015）。列在「其餘三層」那一張表 —— **混進去會讓一條開放問題看起來像九條** | `tests/domain/export.test.ts` |
| `EXPORT_EMPTY_SELECTION`，但畫面上明明有東西 | 送了一個空的 `nodeIds`。**沒送＝整塊，送空陣列＝一個都沒選** | `api-contract.md` |
| 匯出的東西跟畫面上的不一樣 | 不該發生 —— 兩邊是同一支 `subgraph()`。先確認送出的參數跟畫面同一組（`store.query()`）| `export-service.ts` 的檔頭 |

## 文件與治理

| 症狀 | 看哪裡 | 誰守著 |
|---|---|---|
| `AGENTS.md` 與 `CLAUDE.md` 內容不同 | **不要手動改 `AGENTS.md`。** 跑 `tools\Sync-AgentDocs.ps1`（本文取自 `CLAUDE.md`）| `Verify.ps1` 會跑 `-Check` |
| `Verify.ps1` 說有圖過期 | 改過某段 mermaid。跑 `tools\diagrams\Render-Diagrams.ps1` —— 只有變動的那幾張會重算 | `manifest.json` 的 SHA-256 |
| 加了一個錯誤碼之後測試紅了 | **三邊要一起改**：`codes.ts`、`error-codes.md`、`i18n/zh-TW.ts` | `tests/guards/error-codes.test.ts` |
| 在元件裡寫了中文就紅 | 全部走 `web/src/i18n/zh-TW.ts` | `tests/guards/i18n-literals.test.ts` |
| 在 `domain/` import 東西就紅 | `domain/` 零 I/O；`domain/graph/` 更嚴，**連 `domain/` 的其他資料夾都不能 import** | `tests/guards/layering.test.ts`、`domain-graph-deps.test.ts` |
| prettier 想重排 `docs/` 的 Markdown | **不該發生** —— `.prettierignore` 裡有 `*.md`。理由寫在那個檔案裡 | —— |
| 裁決一條相似度／共同提及／轉載的線，回 `GRAPH_LAYER_NOT_ADJUDICABLE` | **那是設計。** 判準不是層別而是「這條邊會不會被重算蓋掉」（`mayAdjudicate`）。**人建的那些層可以裁決** | `tests/domain/edge-state.test.ts` |
| 手動建一條邊回 `GRAPH_EDGE_EXISTS` | 同一個（來源, 目標, 關係型別）已經有一列了。**同一個主張存兩列會讓獨立來源數重複計算** | `tests/e2e/adjudication-flow.test.ts` |
| 機器建的邊 INSERT 成 `confirmed` 就炸 | **順序只有一種**：先 `pending` → 寫出處 → 再 UPDATE。出處有 `edge_id` 外鍵，邊不存在時寫不進去 | `tests/infrastructure/db-constraints.test.ts` |
| 重跑之後否決過的關聯又出現在佇列 | 它帶著**新的 `item`** 回來（ADR-0016 的墓碑例外），面板上會標「曾被否決」。同一份文件換一段話不算 | `tests/e2e/adjudication-flow.test.ts` |
| 校準比例一直是「樣本不足」 | **它是分段的**（`rel` × 可信度等級），不是全域的。同一段要滿 30 條 | `tests/e2e/adjudication-flow.test.ts` |
| 改 `edge_audit` 的列就炸 | 只增不刪 —— 校準比例是從它算出來的。**邊自己被刪掉時的 cascade 不受限** | `tests/infrastructure/db-constraints.test.ts` |

## 四個「看起來像 bug 但不是」

1. **`start_cyclosa.cmd` 開了瀏覽器卻沒起新的 server。**
   那是單一實例：7433 上已經有一個 Cyclosa，所以它開既有的那一個（ADR-0020）。

2. **一批匯入有幾項失敗，但 run 標的是「部分失敗」而不是「失敗」。**
   那是設計。40 個 URL 有 3 個 404，其餘 37 個的內容不該跟著消失 ——
   **只有一個都沒成功才是 `failed`**（`settleRun`）。

3. **一條共同提及線的面板上沒有「待查證／已確認」那個標籤。**
   那是設計。那一欄在那些列上**永遠是 `pending`**（trigger 逼的），
   它不帶資訊 —— 顯示它會讓一個結構性的值看起來像測量結果
   （`edgePanelFieldsFor`，`lessons.md` 有那一條）。
   **人手動建的邊有那個標籤**，因為它的狀態是真的會變的。

4. **一條你自己連的邊沒有「可信度」。**
   同上：`confidence` 那一欄存的 1 是為了讓線畫得夠粗，**不是量出來的**。

5. **一次建圖只抽到兩三條關聯，而模型明明講了很多。**
   多半是引文對不上（`PROVIDER_QUOTE_NOT_FOUND`）。
   **那是設計**：引文在原文裡找不到就沒有這條邊 ——
   一個指不到原文的出處，比沒有出處更糟（ADR-0021）。
   `run_item.code` 會說出來，不是安靜地少幾條。

6. **建圖作業取消了，研究卻仍在「建圖中」。**
   這是為了接著做：作業停下後可「繼續建圖」，只跑未完成的候選。
   使用者取消後另可「到此為止」；關程式中斷不替人做這個決定（`state-machines.md`）。

## 加一條新的守門測試時

**先寫一個會違反它的東西，確認測試真的會紅，再刪掉。**

v0.1.0 的四條守門各注入過一個真實違規驗證（例如在 `domain/case/state.ts` 加
`import { readFileSync } from 'node:fs'`），六個案例全部命中。

> **一條不會紅的守門測試，跟一條不存在的守門測試長得一模一樣。**
> 這個專案已經踩過一次同型的坑（`docs/lessons.md` 的 opt-in 檢查那一條）。
