# 協作：從接到 issue 到合併

**這份給 clone 這個 repo 一起開發的人**，寫的是「怎麼協作」。程式的規則（資料邊界、五條不可違反的規則、分層、命名）
的權威在 `CLAUDE.md`（與內容相同的 `AGENTS.md`）和 `docs/`，這裡不重複 —— 動手之前先讀那兩份。

**任務開在 GitHub issues**，每一張都直接指派了負責人。還不能開始的設了 **blocked by**（issue 右側的 Relationships），
前置的那一張一關掉，標記會自動消失。標籤 `需要維護者環境` 的只有維護者能做（要用到私人的端點、資料或帳號）。
**issue 與 PR 都不寫日期** —— 時程私下講，issue 不會因為時程變了而過期。

## 開工前，只做一次

照 issue #1 做完。**下面五項一定要在第一次 commit 之前做**：

1. **在 Windows 端**裝 Node.js 24.x（`node --version` 要是 `v24`），clone 到 Windows 的資料夾（見〈WSL〉）
2. `git config core.hooksPath .githooks`
3. 作者身分用 GitHub 的 noreply 信箱（`ID` 在 GitHub → Settings → Emails 那一頁）：

   ```powershell
   git config user.name  "<你的 GitHub 帳號>"
   git config user.email "<ID>+<帳號>@users.noreply.github.com"
   ```

4. GitHub → Settings → Emails：勾 **Keep my email addresses private** 與 **Block command line pushes that expose my email**
5. 把維護者私下給你的清單存成 `.git\info\private-terms.txt`（那個位置不在工作樹裡，永遠不會被 commit）

**作者身分或清單裡的詞一旦推上 GitHub，就算刪掉分支也還查得到。** 所以順序不能反過來。

然後 `npm ci` → `.\tools\Verify.ps1` 全綠 → 從檔案總管雙擊 `start_cyclosa.cmd`，照 `README.md` 走一次（不需要模型）。

## 一輪流程

指令都在 repo 根目錄的 Windows PowerShell 裡跑（PowerShell 5.1 沒有 `&&`，一行一個指令）。

**1. 開工。** 在 issue 留言說你開始了。做不完或卡住，就留言說做到哪、卡在哪 —— 不要自己改 Assignees。

**2. 建分支。** 名稱 `<issue 編號>-<英文簡述>`，例如 `3-attach-note-file`：

```powershell
git switch main
git pull --ff-only
git switch -c 3-attach-note-file
```

**3. 改、驗、commit。** 照 issue 的〈照哪份做〉改；commit 之前跑 `.\tools\Verify.ps1`。
訊息照 repo 的寫法：`feat(notes): 附上筆記檔`、`fix(reader): …`、`docs: …`，冒號後面接中文。
**一個 commit 一個邏輯單位** —— 合併時會保留你的每一個 commit。

**4. 推分支、開 PR。**

```powershell
git push -u origin 3-attach-note-file
```

GitHub 頁面會出現 Compare & pull request。PR 範本已經有骨架：第一行寫 `Closes #3`（做完這個 issue）
或 `Refs #3`（只做完一部分），勾完檢查清單。想先拿意見再繼續做，就開成 Draft。

**5. CI。** 每個 PR 都會在 Windows 上跑一次 `Verify.ps1` 與建置（`.github/workflows/verify.yml`）。紅了就修。
**你本機的 `Verify.ps1` 全綠仍然是開 PR 的前提** —— CI 拿不到私人清單，那一道只在你的本機。

**6. 審查。** 維護者的意見會出現在 PR 的對話與 Files changed。照意見在**同一個分支**改、commit、push，
PR 會自動更新；改完按 Re-request review。

**7. 合併 —— 維護者做，你不要按合併鈕**（GitHub 也會擋）。維護者在本機合併、再驗一次之後推上去，
PR 會自動變成 Merged，寫了 `Closes #3` 的 issue 會自動關閉。

**8. 收尾。**

```powershell
git switch main
git pull --ff-only
git branch -d 3-attach-note-file
```

## PR 要一起帶的

| 改了什麼 | 一起改 |
|---|---|
| 任何使用者看得到的變更 | `docs/changelog.md` 的「## 未發行」加一條（版本號由維護者發版時定）|
| schema | migration（`src/infrastructure/db/migrations/`）＋ `docs/architecture/data-model.md`。**同一時間只有一個 PR 能動 migration** —— 動之前先在 issue 說，免得兩邊編出同一個版號 |
| 錯誤碼 | `src/domain/errors/codes.ts`、`docs/architecture/error-codes.md`、`web/src/i18n/zh-TW.ts` 三邊一起（守門測試會比對）|
| UI 字串、顏色 | 字串只寫在 `web/src/i18n/zh-TW.ts`；顏色只用 `web/src/styles/tokens.css` |
| API | `docs/architecture/api-contract.md` |
| 畫面 | PR 附截圖：**只用範例專題或合成資料**，裁掉路徑、視窗標題與別的視窗 |
| 規格跟實作對不上 | 先在 issue 問，不要自己決定 —— 規格以 issue 連到的文件為準 |

## 不要改的

- **版本號**，以及 `README.md`、`CLAUDE.md`、`docs/index.md` 的「現況」標題 —— 發版時由維護者一起改（`tests/guards/version.test.ts` 釘著）
- **`AGENTS.md`** —— 它是產生物。改了 `CLAUDE.md` 之後跑 `.\tools\Sync-AgentDocs.ps1`
- 產生物：`dist/`、`web/dist/`、`docs/architecture/diagrams/*.svg`、`docs/environment/snapshots/`
- `docs/lessons.md` 只追加，不刪、不改舊的條目

## 公開的 repo

**issue、PR、留言、commit、分支，一推上去或一送出就公開。**

- 不寫真實姓名、學校、私人路徑（含使用者名稱的 `C:\Users\…`）、帳號、金鑰，也不寫自己專題裡的內容
- **GitHub 網頁上的文字，守門查不到**（hooks 只看得到 commit）—— issue、PR 描述與留言要自己注意
- 截圖只用範例專題或合成資料
- 金鑰的值不放進任何檔案或留言（規則在 `CLAUDE.md`）

## 會擋你的東西

| 在哪擋 | 擋什麼 |
|---|---|
| GitHub 上 main 的規則 | main 只有維護者能更新（推不進去、合併鈕按不了）；**任何人**都不能強推或刪除 main |
| `.githooks/pre-push` | 推 main 會被擋下，並印出改推到分支的做法 |
| `.githooks/pre-commit` | 5 MB 以上的檔案；私人清單裡的詞（作者身分、檔名、新增的內容）|
| `.githooks/commit-msg` | commit 訊息裡私人清單的詞 |
| CI | `Verify.ps1`（lint、型別、測試與守門）＋ 建置 |

被擋下就照訊息改。**不要用 `--no-verify` 繞過。**

## 跟 AI agent 一起做

- `CLAUDE.md`（Claude Code）與 `AGENTS.md`（Codex）會被自動載入，內容相同。
  **裡面提到的 `D:\Projects\…`、`_meta\…`、`%USERPROFILE%\.claude\…` 是維護者本機的資料夾，你的電腦上沒有** ——
  以這個 repo 裡的文件為準；找不到的就是不存在，不用去建
- agent 也照這一份走：開分支、不推 main、不按合併鈕；它寫的 commit 一樣要過 hooks
- agent 不寫資料根（`CLAUDE.md`「資料位置與讀取邊界」）。用 Claude Code 的話，可以照 `.claude/settings.example.json` 複製一份自己的

## WSL

可以用 WSL 看檔案、跑 git，但 **`npm ci`、`.\tools\Verify.ps1`、`start_cyclosa.cmd` 都在 Windows 端跑**：
這個專案只支援 Windows，而 `node_modules` 裡有依平台安裝的套件 —— 同一份 checkout 在兩邊各跑一次 `npm ci`，會互相蓋掉。

## write 權限做得到、但不要做的事

- 改 issue 的內文、標籤、Assignees 或相依關係（要改就留言）
- 刪別人的分支、關掉不是你的 issue（issue 由合併時的 `Closes #N` 自動關）
- 推 tag（版本的 tag 由維護者打）

## 常見狀況

| 狀況 | 怎麼辦 |
|---|---|
| 推送被 pre-push 擋下（在 main 上 commit 了）| 照訊息做：`git switch -c <分支>`、`git push -u origin <分支>`，再 `git branch -f main origin/main` |
| 作者身分設錯就 commit 了 | **不要 push**，先找維護者 —— 推上去就拿不掉了 |
| PR 顯示跟 main 衝突 | 在你的分支 `git fetch origin`、`git merge origin/main`，解完衝突、跑 `Verify.ps1` 再推；拿不準就在 PR 留言 |
| 被私人清單擋下 | 改內容；確定是誤報就跟維護者說 |
| CI 紅了，本機是綠的 | 在 PR 留言貼 CI 的那一段（去掉路徑），維護者會看 |
| issue 看不懂或有錯 | 在 issue 留言問。issue 被改過的話，維護者會另外留言說改了什麼 |

## 維護者怎麼合併

寫在這裡，讓你知道 PR 送出之後會發生什麼：

1. 抓 PR 的分支，確認每個 commit 的作者與提交者都是 noreply 信箱
2. 用同一份私人清單掃 diff、檔名與 commit 訊息；看 CI；在本機跑 `Verify.ps1` 與 `npm run build`
3. 照 `CLAUDE.md` 的五條規則、分層、命名、i18n 與錯誤碼審一遍，意見貼在 PR
4. 沒問題就在本機 `git merge --no-ff`、再驗一次，推上 main，刪掉分支

真的要改寫 main 的歷史時（例如拿掉不該公開的東西），維護者先暫時停用「不准強推、不准刪除」那條規則，推完立刻改回來。

## 授權

貢獻的程式碼與文件以 MIT 釋出（`LICENSE`）。AGPL 的專案只讀概念、一行程式碼都不抄（`CLAUDE.md`「五條不可違反的規則」第 5 條）。
