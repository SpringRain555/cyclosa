# 版本與它們的界線

**一條沒有理由的版本界線，下一個人不知道能不能動，於是它永遠不會被動。**
所以這一份對每個上下界都寫「為什麼是這個範圍」與「什麼情況下可以放寬」。

> **現況：`package.json` 還不存在。** 下面是**建的時候要照著填的**，
> 不是現在檔案裡的內容。每一條都要在真的寫進 `package.json` 那天再確認一次。

---

## Node：`>=24 <25`

要宣告在兩處：`.node-version`（給版本管理器讀）與 `package.json` 的 `engines.node`。
啟動器要**實際驗 major version** —— 錯的版本當場擋下來，不要拖到很後面才炸。

**下界 24 有兩個獨立的理由，任一個都足夠：**

1. **`node:sqlite`。** 這個專案不引 `better-sqlite3` 也不引 `sqlite3` ——
   原生模組會讓「一鍵啟動」需要編譯工具鏈，那是刻意避開的成本。
   內建的夠用，2026-09-05 在 v24.15.0 上實測過（SQLite 3.51.3、FTS5、JSON1，
   無 experimental warning）。
2. **Vite 8 要 Node 24。**

**上界 `<25` 是保守的，不是有已知問題。** `node:sqlite` 還相對年輕，major 換代
可能改 API。要放寬的話：在 25 上重跑一次那張能力表，確認 `DatabaseSync` 的簽名
沒變，再把三處（`.node-version`、`engines`、這一節）一起改。

## 規劃中的執行期相依

| 套件 | 範圍 | 為什麼 |
|---|---|---|
| `fastify` | `^5` | HTTP 層。單一 process 同時給 API 與前端 |
| `vue` | `^3.5` | 前端 |
| `three` | `^0.17x` | 3D。**跟著 `3d-force-graph` 的 peer 需求走**，不要自己跳版 |
| `3d-force-graph` | `^1` | **MIT。** 包在自訂 `GraphView` 介面後面，換掉的觸發條件見 ADR-0007 |
| `d3-force-3d` | `^3` | **MIT。** 佈局計算，跑在 Web Worker |
| `@mozilla/readability` | `^0.5` | **Apache-2.0。** 正文抽取 |
| `linkedom` | `^0.18` | 給 readability 一個 DOM，不用 jsdom（輕很多）|
| `franc` | `^6` | **MIT。** 語言偵測。偵測不出來記 `und`，不猜 |

**沒有資料庫套件**，那是刻意的（見上面 Node 那一節）。

## 規劃中的開發期相依

| 套件 | 範圍 | 為什麼 |
|---|---|---|
| `vite` | `^8` | 建置與 dev server。**這是 Node 下界的第二個理由** |
| `vitest` | `^5` | 測試。與 vite 同一套 pipeline，版本要跟著走 |
| `typescript` | `^6` | 型別 |
| `vue-tsc` | `^3` | Vue SFC 的型別檢查。**升 typescript 前先確認它支援** |
| `eslint` ＋ `typescript-eslint` ＋ `eslint-plugin-vue` | 相容組 | flat config |
| `prettier` ＋ `eslint-config-prettier` | | 格式衝突由後者關掉 |
| `tsx` | `^4` | 開發時跑 TS 的 server |

**三組要一起升的**，各自單獨升會壞：

1. `vite` ＋ `vitest` ＋ `@vitejs/plugin-vue`
2. `typescript` ＋ `vue-tsc`
3. `eslint` ＋ `typescript-eslint` ＋ `eslint-plugin-vue` ＋ `eslint-config-prettier`

## 刻意不裝的

| | 為什麼 |
|---|---|
| `better-sqlite3`／`sqlite3` | 原生模組 → 一鍵啟動要編譯工具鏈。`node:sqlite` 已經夠用 |
| `sqlite-vec` | 同上。向量第一版用 BLOB ＋ `Float32Array` 純 JS 比對，超過 5 萬筆才重新評估 |
| `jsdom` | 只為了餵 readability 一個 DOM 而已，`linkedom` 輕得多 |
| **`@mermaid-js/mermaid-cli`** | **產圖工具，不進 devDependencies。** 它會拉 Chromium 進 `node_modules`（數百 MB），為一個月用兩次的東西讓每次 `npm ci` 都背著它並不划算。改用 `npx -y '@mermaid-js/mermaid-cli@11'` 用到才下載 —— 做法與 `tagcor-ledger` 一致 |
| Playwright | 第一版靜態優先，**只有 JS-only 的頁面才升級**。升級路徑寫在 `../requirements/REQ-0003-fetch-and-render.md` 的「刻意不做」—— 要先有量測到的 JS-only 比例才引 |

## 授權紅線

**AGPL-3.0 的專案（Datashare、SingleFile、Karakeep、Zotero）一行程式碼都不抄、
也不當依賴。** 只讀概念。這個專案採 MIT，混進 AGPL 程式碼會讓整份授權失效。

加任何新依賴之前**實查它的 `LICENSE`** —— 「我記得它是 MIT」不算
（見 `../research/index.md` 的可信度分級）。
