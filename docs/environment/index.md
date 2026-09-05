# 環境：怎麼建、怎麼更新、怎麼驗證

> ## ⚠️ 現況：還沒有環境可以建
>
> 2026-09-05。這個 repo 裡**沒有 `package.json`、沒有 `package-lock.json`、
> 沒有 `.node-version`** —— 一行程式都還沒有。
>
> 下面寫的是**要建的時候照什麼建**，以及**已經實測過的事實**（那些是真的，
> 在這台機器上量過）。**不要照著執行下面不存在的東西。**

---

## 要建的時候

**只依賴 Node。** 沒有 conda、沒有 Python、沒有 venv、沒有任何原生模組，
也沒有外部 `sqlite3` binary —— 資料庫用內建的 `node:sqlite`。

```powershell
node --version     # 要 24.x
npm ci             # 建好之後：照 lock 檔裝（不是 npm install）
```

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

**目前沒有任何可以跑的驗證。** 有東西可跑的時候，這一節要寫**實際跑過的指令與輸出**，
並分「✅ 跑得動 ／ ❌ 還不存在」兩欄。

> 這句話是刻意的。隔壁的 `rubricator` 曾經在這一節列出一整套指令，其中
> `.\Verify.cmd`、`.\Launch.ps1` 都不存在 —— 照著做的人會撞牆。
> **一份說錯話的環境文件比沒有更糟**，因為它會被當成可以照做的。

## 環境快照

`snapshots/` 目前是空的。做出來的時候，快照**必須去識別化**：使用者名、機器名與
絕對路徑一律換成佔位符，只留 Node／npm 版本、OS 版本、WebGL 能力這類與人無關的事實。
不然公開前檢查會掃到我們自己產的檔。

## 常見問題

**PowerShell 讀 `.json` 出現亂碼。**
PS 5.1 的 `Get-Content -Raw` 預設用系統 ANSI codepage，中文會壞。
用 `node -p "require('./x.json').y"` 或 `Get-Content x.json -Raw -Encoding UTF8`。
檔案本身沒問題。

**`node -e` 裡的引號在 PowerShell 或 Git Bash 下被吃掉。**
兩層跳脫很容易錯。**把腳本寫成獨立的 `.mjs` 檔再跑**，不要跟引號搏鬥。
