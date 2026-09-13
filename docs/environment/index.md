# 環境：怎麼建、怎麼更新、怎麼驗證

> ## 現況：環境建好了（2026-09-07，Stage 5）
>
> `package.json`、`package-lock.json`、`.node-version` 都在 repo 根目錄。
> 下面每一條指令**都實際跑過**。

---

## 怎麼建

**只依賴 Node。** 沒有 conda、沒有 Python、沒有 venv、沒有任何原生模組，
也沒有外部 `sqlite3` binary —— 資料庫用內建的 `node:sqlite`。

```powershell
node --version     # 要 24.x
npm ci             # 照 lock 檔裝（不是 npm install）
```

**多數時候不必手動做這一步** —— `Start Cyclosa.cmd` 發現 `node_modules`
不存在時會自己跑 `npm ci`。

`npm ci` 與 `npm install` 的差別在這裡是實質的：`ci` 完全照 `package-lock.json` 裝、
裝之前先清掉 `node_modules`，而 `install` 會在它覺得需要時更新 lock 檔。
**要重現同一套相依就得用 `ci`。**

三份機器可讀的定義**必須留在 repo 根目錄** —— `package.json`、`package-lock.json`、
`.node-version`。那是 npm 與版本管理器規定的位置，不是我們選的。
**這一區裝的是散文與快照，不是定義本身。**

## 已經實測過的事實

**2026-09-05，Node v24.15.0，npm 11.12.1**（這台機器目前的系統 Node）：

| 能力 | 實測結果 |
|---|---|
| `node:sqlite` 的 SQLite 版本 | **3.51.3** |
| FTS5 | **有**（`pragma_compile_options` 查得到）|
| JSON1 | **有**（已內建進核心）|
| experimental warning | **沒有** |
| FTS5 `trigram` 對中文 | **2 個字的查詢命中 0 列**，3 個字命中 1 列 |

最後一條是**選 Node 24 之外最重要的一個發現**：`trigram` 少於 3 個 unicode 字元
不 match 是它的設計，而中文查詢多半是 2 字詞。**所以中文檢索要在應用層自建 bigram 索引**
（見 `../architecture/data-model.md`）。

## 怎麼驗證

| 指令 | 現況 | 做什麼 |
|---|:--:|---|
| `.\tools\Verify.ps1` | ✅ | lint ＋ prettier ＋ 型別（server／web 兩套）＋ 134 個測試 ＋ 兩份 agent 檔比對 ＋ 圖表是否過期 |
| `.\tools\Verify.ps1 -Report` | ✅ | 另外產出去識別化的環境快照到 `snapshots/` |
| `npm test` | ✅ | 只跑測試 |
| `npm run typecheck` | ✅ | `tsc` ＋ `vue-tsc` |
| `npm run lint` | ✅ | `eslint` ＋ `prettier --check` |
| `npm run build` | ✅ | server（`dist/`）＋ 前端（`web/dist/`）|

**2026-09-07 實跑全綠。**

> 這一節曾經是空的，而那是刻意的。隔壁的 `rubricator` 在它的這一節列出一整套指令，
> 其中 `.\Verify.cmd`、`.\Launch.ps1` 都不存在 —— 照著做的人會撞牆。
> **一份說錯話的環境文件比沒有更糟**，因為它會被當成可以照做的。
> **所以這張表的每一列都是跑過的，不是打算跑的。**

## 環境快照

`snapshots/` 由 `.\tools\Verify.ps1 -Report` 產生，**是產生物，不要手改**。

快照**必須去識別化**：使用者名、機器名與絕對路徑一律不寫，
只留 Node／npm 版本、OS 版本、SQLite 版本這類與人無關的事實 ——
不然公開前檢查會掃到我們自己產的檔（REQ-0008）。

**效能數字不進快照**，要等 Stage 13 的合成資料驗收，而且要連同量測方法一起寫。
**沒有量測條件的數字不能拿來做決定。**

## 常見問題

**PowerShell 讀 `.json` 出現亂碼。**
PS 5.1 的 `Get-Content -Raw` 預設用系統 ANSI codepage，中文會壞。
用 `node -p "require('./x.json').y"` 或 `Get-Content x.json -Raw -Encoding UTF8`。
檔案本身沒問題。

**`node -e` 裡的引號在 PowerShell 或 Git Bash 下被吃掉。**
兩層跳脫很容易錯。**把腳本寫成獨立的 `.mjs` 檔再跑**，不要跟引號搏鬥。
