# 環境：怎麼建、怎麼驗證、怎麼更新

**這個專案只依賴系統 Node 24。** 沒有 conda、沒有 Python、沒有 venv、沒有任何原生模組，
也沒有外部 `sqlite3` binary —— 資料庫用內建的 `node:sqlite`。每條版本界線**為什麼是那個範圍**
在 [versions.md](versions.md)。這一份是 CONVENTIONS §12 的「專案環境文件」，六個段落固定。

> **機器可讀的定義不在這一區。** `package.json`、`package-lock.json`、`.node-version`
> 必須留在 repo 根目錄 —— 那是 npm 與版本管理器規定的位置，不是我們選的。
> 這一區裝的是散文與快照，不是定義本身。
>
> 下面每一條指令**都實際跑過**。這一節曾經是空的，而那是刻意的：隔壁的 `rubricator`
> 曾在它的這一節列出一整套不存在的指令，照著做的人會撞牆。
> **一份說錯話的環境文件比沒有更糟**，因為它會被當成可以照做的。

## 1. runtime 與版本

| | |
|---|---|
| runtime | 系統 Node **24.x**（`engines`：`>=24 <25`；`.node-version`：`24`） |
| 版本界線 | **下界 24 只有一個理由：`node:sqlite`**。「Vite 8 要 Node 24」是假的，見 [`lessons.md`](../lessons.md)；上界與相依的理由在 [versions.md](versions.md) |
| 機器可讀的定義 | `package.json`（含 `engines`）、`package-lock.json`、`.node-version`，都在根目錄 |
| **PATH 上那個能不能用** | **能，如果它是 24.x。** `tools\Launch.ps1` 會先驗版本；PATH 上不是 24 的話設 `CYCLOSA_NODE` 指到對的 `node.exe`（見 §5），不要去改 PATH |

**2026-09-05 在 Node v24.15.0、npm 11.12.1 上實測的能力**（選 Node 24 的依據）：

| 能力 | 實測結果 |
|---|---|
| `node:sqlite` 的 SQLite 版本 | **3.51.3** |
| FTS5 | **有**（`pragma_compile_options` 查得到）|
| JSON1 | **有**（已內建進核心）|
| experimental warning | **沒有** |
| FTS5 `trigram` 對中文 | **2 個字的查詢命中 0 列**，3 個字命中 1 列 |

最後一條是**選 Node 24 之外最重要的一個發現**：`trigram` 少於 3 個 unicode 字元
不 match 是它的設計，而中文查詢多半是 2 字詞。**所以中文檢索在應用層自建 bigram 索引**
（見 [`data-model.md`](../architecture/data-model.md)）。

## 2. 怎麼建

```powershell
node --version     # 要 24.x
npm ci             # 照 lock 檔裝（不是 npm install）
npm run build      # server（dist/）＋ 前端（web/dist/）
```

**多數時候不必手動做** —— 雙擊 `start_cyclosa.cmd` 發現 `node_modules` 不存在時會自己跑
`npm ci`，發現產物比原始碼舊時會自己建置。

`npm ci` 與 `npm install` 的差別在這裡是實質的：`ci` 完全照 `package-lock.json` 裝、
裝之前先清掉 `node_modules`，而 `install` 會在它覺得需要時更新 lock 檔。
**要重現同一套相依就得用 `ci`。**

## 3. 怎麼驗證

```powershell
.\tools\Verify.ps1          # eslint → prettier → 型別（server 與測試、web 兩套）→ 測試（含 tests/guards/）→ 兩份 agent 檔比對 → 圖表是否過期
.\tools\Verify.ps1 -Report  # 另外產出去識別化的環境快照到 snapshots/
```

全綠長這樣：每一段 `OK`，最後一行「全部通過。」，exit 0。**測試的數量不寫在這裡** ——
寫死的數字每一版都會漂（這一份曾寫著「134 個測試」，而那個數字停在 v0.1.0）。
要單獨跑某一段：`npm test`、`npm run typecheck`（`tsc` ＋ `vue-tsc`）、`npm run lint`
（`eslint` ＋ `prettier --check`）、`npm run build`。

**最常紅的兩種，都不是程式壞了**：

- **prettier 對一堆沒動過的檔報格式錯** —— 行尾。`.gitattributes` 對原始碼宣告了 `eol=lf`；
  工作樹如果是舊的 CRLF 簽出，在乾淨的樹上 `git rm --cached -r . ; git reset --hard` 重新簽出一次。
- **e2e 的 `beforeEach` 逾時** —— 沙箱在慢的地方。測試的沙箱由 `vitest.config.ts` 釘在
  repo 自己的 `tmp/vitest/`；不要把它改回使用者的 Temp（[`lessons.md`](../lessons.md) 2026-09-13）。

## 4. 怎麼更新

1. **升一個套件**：`npm install <pkg>@<版本>`（lock 檔會跟著改，**要一起提交**），然後
   `.\tools\Verify.ps1`。[versions.md](versions.md) 說了哪幾組要一起升
   （vite／vitest 同一套 pipeline；`typescript` 卡在 `~6.0` 是 `typescript-eslint` 的關係）。
2. **換一代 Node**：`package.json` 的 `engines`、`.node-version`、[versions.md](versions.md) 的理由，
   三處一起動；然後 `npm ci` 重裝（原生模組沒有，所以不會有重編譯的問題）。
3. 更新完跑 `.\tools\Verify.ps1`，再 `npm run build` 確認產物建得出來。

## 5. 環境變數

| 變數 | 誰讀 | 做什麼 |
|---|---|---|
| `CYCLOSA_NODE` | `tools\Launch.ps1` | 指定 `node.exe`，優先於 PATH。PATH 上不是 24.x 時設一次：`setx CYCLOSA_NODE "X:\path\to\node24\node.exe"` |
| `CYCLOSA_FETCH_INTERVAL_MS` | `src/application/fetch-policy.ts` | 同網域請求間隔（毫秒）。沒設用預設；**小於下限會被夾到下限**，不是照做；不是數字當成沒設。數字與理由在 [`fetch-policy.md`](../architecture/fetch-policy.md)。測試裡由 `vitest.config.ts` 清成預設 |
| `CYCLOSA_LOG_LEVEL` | `src/shared/log.ts` | 日誌門檻；`silent` 完全不寫（測試用它，因為 e2e 刻意製造失敗） |
| `CYCLOSA_LOG_FILE` | `src/shared/log.ts` | 同時寫一份日誌到這個檔。`tools\Launch.ps1` 把它設成 `%LOCALAPPDATA%\Cyclosa\logs\server.log` —— 隱藏視窗跑的行程沒有 stderr |
| `LOCALAPPDATA` | `src/infrastructure/fs/paths.ts` | 指標檔 `%LOCALAPPDATA%\Cyclosa\system_paths.json` 與預設資料根的位置；非 Windows 退回 `XDG_DATA_HOME` |
| `<設定頁填的環境變數名>` | `src/infrastructure/providers/http.ts` | 線上 chat 端點的金鑰。**存的是變數名不是值**，值只在送出請求那一刻讀一次 |
| `OLLAMA_HOST` | `tools/research/eval-*.ts` | 只有量測腳本讀；App 本身用設定頁的端點位址 |
| `TMP`／`TEMP` | vitest | 測試沙箱的位置，由 `vitest.config.ts` 釘在 `tmp/vitest/`（§3） |
| `LOCALAPPDATA` | 指標檔的位置；測試時 vitest | App 從它推導 `Cyclosa\system_paths.json`。**測試行程裡由 `vitest.config.ts` 釘在 `tmp/vitest/LocalAppData/`** —— 否則逾時的測試會把真的指標檔寫成指著沙箱（[`lessons.md`](../lessons.md) 2026-09-14） |

## 6. 已知的坑

只放環境層的；程式邏輯的坑在 [`lessons.md`](../lessons.md)。

- **PowerShell 5.1 讀 `.json` 出現亂碼。** `Get-Content -Raw` 預設用系統 ANSI codepage，中文會壞。
  用 `node -p "require('./x.json').y"` 或 `Get-Content x.json -Raw -Encoding UTF8`。檔案本身沒問題。
- **`node -e` 裡的引號在 PowerShell 或 Git Bash 下被吃掉。** 兩層跳脫很容易錯 ——
  **把腳本寫成獨立的 `.mjs` 檔再跑**，不要跟引號搏鬥。
- **PowerShell 5.1 把原生指令的 stderr 當成錯誤**（`NativeCommandError`）：
  測試裡 app 的 warn 會讓 `tools\Verify.ps1` 誤判成失敗，所以 vitest 把 `CYCLOSA_LOG_LEVEL` 設成 `silent`。
- **`core.autocrlf = true` 的機器**：工作樹簽出是 CRLF，`.gitattributes` 對原始碼宣告 `eol=lf` 才擋得住
  prettier 全紅（§3）。
- **使用者的 Temp 慢**（C: 上的即時掃描）：沙箱不在那裡（§3）。
- **編碼**：`.ps1` 必須有 UTF-8 BOM（PS 5.1 否則當 Big5 讀）；`.md`／`.json` 不要 BOM；`.cmd` 純 ASCII。

## 環境快照

`snapshots/` 由 `.\tools\Verify.ps1 -Report` 產生，**是產生物，不要手改**。

快照**必須去識別化**：使用者名、機器名與絕對路徑一律不寫，只留 Node／npm 版本、OS 版本、
SQLite 版本這類與人無關的事實 —— 不然公開前檢查會掃到我們自己產的檔（REQ-0008）。
這個專案的做法是**根本不把那些東西放進去**（每一行都是版本號），不是事後過濾；
要加一行之前先問「它會不會帶出一個名字或路徑」。

**效能數字不進快照**，在 [`performance.md`](performance.md)，而且要連同量測方法一起寫。
**沒有量測條件的數字不能拿來做決定。**
