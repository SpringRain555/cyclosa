# 版本與它們的界線

**一條沒有理由的版本界線，下一個人不知道能不能動，於是它永遠不會被動。**
所以這一份對每個上下界都寫「為什麼是這個範圍」與「什麼情況下可以放寬」。

> **現況（2026-09-07）：下面每一條都在 `package.json` 裡了。**
> 授權欄是逐一實查的結果，**而且是開 `LICENSE` 檔看的，不是只信 metadata**
> （Zotero 就是那個反例，見 `research/market-scan.md`）。
>
> 每一批都在寫進 `package.json` 的那一天重查一次 —— 這是這份文件自己的要求。

---

## Node：`>=24 <25`

要宣告在兩處：`.node-version`（給版本管理器讀）與 `package.json` 的 `engines.node`。
啟動器要**實際驗 major version** —— 錯的版本當場擋下來，不要拖到很後面才炸。

**下界 24 只有一個理由，而它足夠：**

1. **`node:sqlite`。** 這個專案不引 `better-sqlite3` 也不引 `sqlite3` ——
   原生模組會讓「一鍵啟動」需要編譯工具鏈，那是刻意避開的成本。
   內建的夠用，2026-09-05 在 v24.15.0 上實測過（SQLite 3.51.3、FTS5、JSON1，
   無 experimental warning）。

> ### 這裡本來寫著第二個理由，而那個理由是假的
>
> 2026-09-06 之前這一節寫「下界 24 有**兩個**獨立的理由，任一個都足夠」，
> 第二個是「**Vite 8 要 Node 24**」。實查 `registry.npmjs.org/vite/latest`：
>
> ```
> vite 8.2.2 · engines.node = ^20.19.0 || >=22.12.0
> ```
>
> **Vite 8 不要求 Node 24。** 下界仍然是 24，但**它現在只有一條腿** ——
> 要放寬的時候，要處理的只有 `node:sqlite` 這一件事，不必再去確認 Vite。
>
> 這一條值得留在這裡而不是默默刪掉：一個寫著「兩個獨立理由、任一個都足夠」的界線，
> 讀的人會覺得它特別穩固，於是不會去查。**假的理由比沒有理由更難拆。**
> （`vitest` 5.0.0 的 `engines.node` 是 `^22.12.0 || ^24.0.0 || >=26.0.0`，Node 24 通過。）

**上界 `<25` 是保守的，不是有已知問題。** `node:sqlite` 還相對年輕，major 換代
可能改 API。要放寬的話：在 25 上重跑一次那張能力表，確認 `DatabaseSync` 的簽名
沒變，再把三處（`.node-version`、`engines`、這一節）一起改。

## 規劃中的執行期相依

**授權欄是 2026-09-06 逐一實查 `registry.npmjs.org/<pkg>/latest` 的 `license` 欄**
（A 級，紀錄在 `../research/query-log.md`）。版本欄是那天的 latest。

| 套件 | 範圍 | 授權 | 為什麼 |
|---|---|---|---|
| `fastify` | `^5.12` | MIT | HTTP 層。單一 process 同時給 API 與前端 |
| `vue` | `^3.5` | MIT | 前端 |
| `vue-router` | `^5.3` | MIT | 三個分頁的路由 |
| `pinia` | `^4` | MIT | 狀態 |
| `three` | `>=0.179 <1` | MIT | 3D。**這個範圍不是我們訂的** —— 它抄自 `3d-force-graph` 1.80.0 自己宣告的相依範圍，**照抄是為了讓 npm 去重成同一份**（two three.js instances 是這個生態最常見的壞法）。2026-09-06 的 latest 是 **0.185.1** |
| `3d-force-graph` | `^1.80` | MIT | 包在自訂 `GraphView` 介面後面，換掉的觸發條件見 ADR-0007 |
| `d3-force-3d` | `^3` | MIT | 佈局計算，跑在 Web Worker |
| `@mozilla/readability` | `^0.6` | **Apache-2.0** | 正文抽取 |
| `linkedom` | `^0.18` | **ISC** | 給 readability 一個 DOM，不用 jsdom（輕很多）|
| `franc` | `^6.2` | MIT | 語言偵測。偵測不出來記 `und`，不猜 |
| `pdfjs-dist` | `^6.3` | **Apache-2.0** | PDF 的文字層與頁碼。**第一版就要**（REQ-0006 ＋ ADR-0019 的頁碼錨點）|
| `@local-app/lifecycle` | `file:vendor/local-app-lifecycle-0.1.0.tgz` | 本 repo 的 MIT（見下）| healthz 探測與有上限的關閉序列，幾個本機 app 共用（`architecture/app-lifecycle.md`）|

> **`@local-app/lifecycle` 不是從 npm 裝的**（2026-10-08 加，2026-10-09 補記在這裡）：tarball 與 `package-lock.json` 一起版控在
> `vendor/`，單獨 clone 也 `npm ci` 得起來；PowerShell 那一半（`vendor/AppLifecycle.psm1`）給啟動器載入。
> **它是同一個作者的程式**，隨這個 repo 以 MIT 釋出 —— 但 tarball 裡的 `package.json` **沒有 `license` 欄**、也沒有附 `LICENSE`。
> 那不是「沒有授權」，是沒寫：**下次升版時在來源補上 `"license": "MIT"`**，再重打 tarball。
> 2026-10-09 開過 tarball：六個檔（兩支 `.js`、兩份 `.d.ts`、`package.json`、`tools/AppLifecycle.psm1`），沒有任何相依、沒有私人路徑。

> **這四個在 2026-09-07 寫進 `package.json` 那天重查了一次**（這份文件自己要求的）：
> `@mozilla/readability` 0.6.0 Apache-2.0、`linkedom` 0.18.13 ISC、
> `franc` 6.2.0 MIT、`pdfjs-dist` 6.3.289 Apache-2.0。**四條範圍都不用動。**
>
> 裝完之後掃了整棵相依樹的授權欄位：**258 個套件，沒有任何 GPL／AGPL／SSPL／BUSL**。
> 有 2 個 MPL-2.0 —— 那是**檔案層級**的 copyleft，當依賴用沒有問題。

> **三個 3D 套件在 2026-09-07寫進 `package.json` 那天也重查了一次。**
> 解出來的版本：`three` **0.185.1**、`3d-force-graph` **1.80.0**、
> `d3-force-3d` **3.0.6**，另外被帶進來的 `three-forcegraph` 1.43.4 與
> `three-render-objects` 1.42.0 —— **五個都開過 `LICENSE` 檔，全部 MIT。**
>
> **`>=0.179 <1` 這個範圍達成了它的目的**：`npm ls three` 顯示
> `three-forcegraph`、`three-render-objects` 與我們自己的相依
> **全部 deduped 到同一份 0.185.1**，node_modules 裡只有一個 `three`。
>
> 另外加了 **`@types/three` `^0.185`（MIT）** 當開發期相依 ——
> **`three` 本身不附型別**（它的 `package.json` 沒有 `types` 欄），
> 而 `3d-force-graph` 的 `.d.ts` 會 `import from 'three'`，少了它 `vue-tsc` 過不了。
> 版本要跟著 `three` 的 minor 走。
>
> **`d3-force-3d` 完全沒有型別**，DefinitelyTyped 上也沒有
> （`@types/d3-force` 是 2D 版的，形狀不一樣 —— 用它會得到一份看起來對
> 但少一個維度的型別）。所以 `web/src/types/d3-force-3d.d.ts` 是**手寫的，
> 而且只宣告實際用到的那幾支** —— 補齊其他的只會跟上游安靜地分岔。
>
> 整棵樹重掃：**299 個套件（+41），仍然 0 個 GPL／AGPL／SSPL／BUSL。**
>
> **2026-09-28 再重盤一次**（市場調查重查的同一天，讀 `node_modules` 裡每個套件的 `package.json`）：
> **321 個套件**，MIT 244、ISC 26、Apache-2.0 19、BSD-2-Clause 19、BSD-3-Clause 10、MPL-2.0 2、BlueOak-1.0.0 1；
> **GPL／AGPL／BSL／未宣告：0**。MPL-2.0 是 `lightningcss`（由 `vite` 帶進來、只在建置時用），
> BlueOak 是 `minimatch`（`eslint` 帶進來）。明細在 `../research/market-scan.md` 的「相依授權重盤」。
>
> **`pdfjs-dist` 是動態載入的**（`await import`），只有真的遇到 PDF 才會被讀進來。
> 它不小，而啟動時間是一鍵啟動體驗的一部分。

**沒有資料庫套件，也沒有嵌入模型套件。** 前者是刻意的（見上面 Node 那一節）；
後者是因為嵌入走本機 Ollama 的 HTTP 端點，**不是** npm 套件 —— 見下面「刻意不裝的」。

> **`three` 的範圍寫成 `>=0.179 <1` 而不是 `^0.185` 是有意的。**
> three.js 是 0.x 版本號，而 npm 的 `^0.185.1` 只等於 `>=0.185.1 <0.186.0` ——
> 每次 three 出小版都會跟 `3d-force-graph` 的相依解出兩份不同的 three。
> **兩份 three 同時載入的症狀是 `instanceof` 全部失敗**，而錯誤訊息完全看不出原因。

## 規劃中的開發期相依

| 套件 | 範圍 | 授權 | 為什麼 |
|---|---|---|---|
| `vite` | `^8.2` | MIT | 建置與 dev server。**不是** Node 下界的理由（見上面那個更正）|
| `vitest` | `^5` | MIT | 測試。與 vite 同一套 pipeline，版本要跟著走 |
| `typescript` | **`~6.0`** | Apache-2.0 | 型別。**上界不是我們訂的** —— 見下面那條 |
| `vue-tsc` | `^3.3` | MIT | Vue SFC 的型別檢查。它的 peer 是 `typescript >=5.0.0`，很寬 |
| `eslint` | `^10` | MIT | flat config |
| `typescript-eslint` | `^8.69` | MIT | **它就是 TypeScript 的上界來源** |
| `eslint-plugin-vue` | `^10.11` | MIT | |
| `prettier` ＋ `eslint-config-prettier` | `^3.9` / `^10.1` | MIT | 格式衝突由後者關掉 |
| `tsx` | `^4.23` | MIT | 開發時跑 TS 的 server |
| `@vitejs/plugin-vue` | `^6` | MIT | |
| `globals`、`@types/node` | `^17` / `^26` | MIT | |

### TypeScript 卡在 `~6.0`，而卡住它的是 `typescript-eslint`

2026-09-06 實查（A 級）：

```
typescript        dist-tags：latest = 7.0.2，6.x 最新是 6.0.3
typescript-eslint 8.69.0（最新）peer：typescript >=4.8.4 <6.1.0
                  往回查 8.64／8.65／8.66／8.67／8.68 —— 全部一樣
```

**所以範圍是 `~6.0` 不是 `^6`。** `^6` 允許 6.1，而 6.1 就出了 `typescript-eslint` 的
peer 範圍 —— 那不是「以後可能會壞」，是宣告上就已經不相容。
**TypeScript 7 更是完全不能用**，即使它已經是 latest。

放寬的條件很明確：**`typescript-eslint` 發一版把 peer 上界推上去。**
在那之前不要因為「latest 是 7」就升 —— 那個 latest 對這套工具鏈是超前的。

**三組要一起升的**，各自單獨升會壞：

1. `vite` ＋ `vitest` ＋ `@vitejs/plugin-vue`
2. `typescript` ＋ `vue-tsc` ＋ **`typescript-eslint`**（它才是那組的天花板）
3. `eslint` ＋ `typescript-eslint` ＋ `eslint-plugin-vue` ＋ `eslint-config-prettier`

## 刻意不裝的

| | 為什麼 |
|---|---|
| `better-sqlite3`／`sqlite3` | 原生模組 → 一鍵啟動要編譯工具鏈。`node:sqlite` 已經夠用 |
| `sqlite-vec` | 同上。向量第一版用 BLOB ＋ `Float32Array` 純 JS 比對，超過 5 萬筆才重新評估 |
| `jsdom` | 只為了餵 readability 一個 DOM 而已，`linkedom` 輕得多 |
| **`@mermaid-js/mermaid-cli`** | **產圖工具，不進 devDependencies。** 它會拉 Chromium 進 `node_modules`（數百 MB），為一個月用兩次的東西讓每次 `npm ci` 都背著它並不划算。改用 `npx -y '@mermaid-js/mermaid-cli@11'` 用到才下載 —— 做法與 `tagcor-ledger` 一致 |
| Playwright | 第一版靜態優先，**只有 JS-only 的頁面才升級**。升級路徑寫在 `../requirements/REQ-0003-fetch-and-render.md` 的「刻意不做」—— 要先有量測到的 JS-only 比例才引 |
| 任何嵌入模型的 npm 套件 | 嵌入走**本機 Ollama 的 HTTP 端點**，模型是使用者自己拉的（第一版用 `qwen3-embedding:4b`，2560 維）。裝進 `node_modules` 的話等於把數 GB 的權重綁進 `npm ci` |

## 執行期的外部相依（不是 npm 套件）

**這兩個不在 `package.json` 裡，但少了它們會有功能跑不動。**
兩個都走 ADR-0006 的能力宣告 —— **配不上就報錯停手，不靜默降級**。

| | 用途 | 沒有的話 |
|---|---|---|
| `claude` CLI | 研究規劃、缺口評估與找來源的可選連線 | 選用 CLI 的任務須通過能力檢查；也可改用相容端點，匯入等不依賴它 |
| 本機 Ollama ＋ **`hf.co/mykor/granite-embedding-311m-multilingual-r2-GGUF:BF16`** | `embed` 任務（ADR-0035 建議值） | 語意檢索報同一個碼；**全文檢索不受影響**（那是純 SQLite） |

> **嵌入模型換掉就全毀，而且它不會報錯。** LightRAG 的文件明寫模型一旦選定就不能換，
> 換了要全部重算 —— 而**餘弦相似度對兩個不同模型的向量照樣算得出數字**。
> 所以向量列要記 `model` ＋ `dim`，查詢時模型不符**拒絕比對**。
> 詳見 `../research/market-scan.md` 發現 ⑧ 與 `../architecture/data-model.md`。

## 授權紅線

**AGPL-3.0 的專案（Datashare、SingleFile、Karakeep、Linkwarden、Zotero、InfraNodus 的 Obsidian 外掛、Reor）
一行程式碼都不抄、也不當依賴。** 只讀概念。
這個專案採 MIT，混進 AGPL 程式碼會讓整份授權失效。

> **Linkwarden 是 2026-09-06 補進這張名單的** —— 它一直在市場調查的賽道表裡，
> 卻沒進授權盤點表。**在賽道表裡出現而不在紅線上，比完全沒提到更危險。**
>
> **InfraNodus 的 Obsidian 外掛與 Reor 是 2026-09-28 重查新增的**（`../research/market-scan.md` 的授權盤點）——
> 同一條教訓，這次是 09-28 寫進市場調查、09-29 才補進這裡。
>
> **SurfSense 是混合授權**：GitHub API 回 `NOASSERTION`，讀 `LICENSE` 才知道
> `surfsense_backend/app/proprietary/` 是 **Business Source License 1.1**、其餘 Apache-2.0。
> 借之前先看是哪一個資料夾 —— 跟 Zotero 同一個教訓的第二個實例。

加任何新依賴之前**實查它的 `LICENSE`** —— 「我記得它是 MIT」不算
（見 `../research/index.md` 的可信度分級）。

> **而且不能只查 GitHub API 的 `license` 欄。** Zotero 就是反例：API 回 `NOASSERTION`，
> 要開 `COPYING` 才看得到 AGPLv3。**API 說「不知道」的時候，答案不是「沒有授權」。**
