# ADR-0037 沒有指標檔時照四步找，第一次啟動三選一

- 狀態：**已採納**（2026-10-11）
- 依據：上游 `D:\Projects` CONVENTIONS §11「沒有指標檔時：四步」（2026-10-11）—— 那天量到 8 個本機 app 在「沒有指標檔」時有 7 種做法，統一成 `tagcor-ledger` ADR-0018 的形狀
- 取代：v0.17.0「開箱即用」裡「指標檔不存在 → 不問，直接建 `%LOCALAPPDATA%\Cyclosa\data`」那一條（`roadmap.md` v0.17.0 一節）
- 修訂：ADR-0004（資料與程式分離）—— 多了一個資料在程式資料夾底下的選項，見「代價」
- 實作：`src/infrastructure/fs/paths.ts`、`src/application/bootstrap-service.ts`、`src/interface/http/routes.ts`、`web/src/views/CaseListView.vue`、`web/src/components/StoragePanel.vue`；
  機制在共用套件 `@local-app/lifecycle@0.2.0` 的 `data-location`。測試 `tests/e2e/first-run.test.ts`、`tests/e2e/case-flow.test.ts`、`tests/e2e/data-root-move.test.ts`、`tests/guards/test-isolation.test.ts`

## 背景

v0.17.0 讓第一次啟動「一個問題都不必回答」：指標檔不存在就自己建 `%LOCALAPPDATA%\Cyclosa\data`、寫指標檔、放一份範例專題。
那一版刻意只讓「指標檔不存在」走自動建立，另外三種故障（指標檔壞了、指到的不在、寫不進去）照原樣停下來 ——
理由是那三種後面可能有一整份資料，而「指標檔不存在」是「唯一一種可以確定沒有任何舊資料的狀態」。

**那句話不成立。** 指標檔不存在也可能是**指標檔遺失**：重灌、清掉 AppData、換一台電腦但資料在隨身碟上。
那時候自動建立會默默生出一份空的資料根，畫面是一個乾淨的清單（還多一份範例專題），一個字都沒說 ——
使用者看到的就是「資料全部不見了」。那正是 REQ-0001 花四個錯誤碼在擋的畫面，只是從另一個門進來。

上游把同一個問題在 8 個 app 上一起處理，規則寫成 CONVENTIONS §11 的四步。Cyclosa 照著改。

## 決定

**每次啟動照同一個順序找，找到就停**（Cyclosa 沒有開發用的覆寫，所以沒有第 0 步）：

1. 指標檔在 → 照它。讀不懂、指到的不在、寫不進去 → 各自的錯誤碼，**停下**；不往下找、不頂替
2. `<程式資料夾>\userdata\data-root.json` 在 → 用它，不寫指標檔
3. `%LOCALAPPDATA%\Cyclosa\data\data-root.json` 在 → 用它，不寫指標檔
4. 都沒有 → `IO_POINTER_MISSING`，清單頁問三選一。**問之前什麼都不建**

| 三選一 | 資料根 | 寫指標檔？ |
|---|---|:--:|
| **放在程式資料夾裡**（預選） | `<程式資料夾>\userdata` | 否 |
| 放在這台電腦的使用者資料夾 | `%LOCALAPPDATA%\Cyclosa\data` | 否 |
| 其他位置… | 使用者給的資料夾；**已經有 `data-root.json` 就接上它** | 是（版面建好之後） |

細節：

- **marker 是資料根頂層的 `data-root.json`**（`{"app":"cyclosa","version":1}`）。Cyclosa 沒有天然的 marker：
  資料庫一個專題一個，而專題可以被刪光 —— 「專題刪光了就認不得」的資料根，在指標檔遺失時會被當成沒有資料。
  建版面時寫（`wx`，不覆寫），打開既有的資料根時補上（2026-10-11 之前建的都沒有）。
- **程式資料夾**是往上找 `name` 為 `cyclosa` 的 `package.json` 的那一層；找不到時那個選項關掉（不是拿掉）。
  `/userdata/` 整個進 `.gitignore`，`tools\Verify.ps1` 用 `git check-ignore` 驗。
- **其他位置擋三種**，搬家的目標也擋同樣三種（新錯誤碼 `IO_DATA_ROOT_LOCATION_INVALID`）：整顆磁碟的根目錄、
  程式資料夾裡面（**連 `userdata` 也擋** —— 從這裡選會把一個資料夾一搬就失效的絕對路徑寫進指標檔）、不是完整路徑。
  （同日追加第四種「既有資料根裡面」，見文末追記。）
- **範例專題只放進這一次才建出來的資料根**（選之前沒有 marker）。接上既有的不放；marker 就是那個旗標。
- **指標檔的 key 換成 `data_root`**（上游統一）。舊的 `{ dataRoot, updatedAt }` 照樣讀得懂，下一次寫才換成新的形狀。
- **搬家之後一律寫指標檔**，不管原本是從哪一步找到的。跨磁碟區搬時舊位置的 marker 最先刪 ——
  刪不乾淨的殘骸不能在指標檔遺失時被第 2、3 步當成資料根接上。
- `POST /api/system/data-root` 收 `{ choice, dataRoot? }`；沒給 `choice` 當成 `other`，舊的請求不必改。
- 指標檔壞掉時，畫面只給「其他位置」：另外兩個不寫指標檔，壞掉的那一份下次啟動還在。

## 考慮過但沒選的

| 方案 | 為什麼不選 |
|---|---|
| 維持「不問就建」 | 就是「背景」那一段：指標檔遺失時默默生出一份空的資料根 |
| 不問就建，但建在程式資料夾 | 一樣是不問就建，只是換了位置；指標檔遺失時照樣看不出來 |
| 回到 v0.17.0 之前「只有打字」那一題 | 下載來試用的人要自己發明一個資料夾；也說不出「選回原本那個就接上了」 |
| 停用「放在程式資料夾裡」 | 上游允許停用的理由是「裝在寫不進去的地方」或「資料含憑證」，Cyclosa 兩個都不是 —— 金鑰不在資料根裡（存的是環境變數的名字），程式是解壓縮或 clone 出來的資料夾 |
| 自己寫一份四步，不用共用套件 | Node 那一側已經有 `@local-app/lifecycle`；多一份複本就是上游 §16 要避免的漂移 |
| 用一個「問過了」的旗標代替 marker | 旗標是第二份會跟檔案對不上的事實：旗標說問過了，資料卻被刪了 |

## 代價

- **第一次啟動多一題。** v0.17.0 的「一個問題都不必回答」沒了。預選了一個合理的答案，按一下就過；
  而那一題在指標檔遺失時跳出來，本身就是「不對勁」的訊號。
- **ADR-0004 那句「結構上不可能洩漏」對「放在程式資料夾裡」不成立。** 那個選項的資料在 repo 底下，
  安全性押在 `/userdata/` 那一行與 `Verify.ps1` 的檢查上。維護者本機一律走指標檔（第 1 步），不用這個選項。
- 選程式資料夾的人換新版（解到新的資料夾）時，要自己把 `userdata` 帶過去 —— 畫面與 README 都寫了。
- ~~`tools\Launch.ps1 -LocalAppData` 換不到程式資料夾~~ —— 同日修掉，見文末追記。
- 測試多一個要隔離的位置（`CYCLOSA_PROGRAM_DIR`）。沒隔離的話不只會碰到真的 `userdata\`：
  所有沙箱都在 repo 的 `tmp/vitest/` 底下，會被當成「程式資料夾裡面」擋掉。
- 依賴一個 vendored 的共用套件，升版要重打 tarball、複製、**明確重裝**（同名的 tarball npm 會說 up to date）。

## 什麼情況要重新考慮

- 開始打包成安裝程式（裝進寫不進去的地方）：程式資料夾那個選項會因為寫不進去而失敗，預選要改。
- 上游 CONVENTIONS §11 的四步改了：跟著改，這一份標「已取代」。

## 追記

- **2026-10-11**：上游 §11 把「其他位置」的第三種拒絕從「marker 所在的那一層」改成「既有資料根裡面的資料夾」
  （任何一層上層有 marker 就擋；共用套件 0.3.0，原因代碼 `inside-data-root`）。Cyclosa 的 marker（`data-root.json`）
  在資料根頂層，舊的寫法對它等於沒擋 —— 挑到另一份資料根的 `cases` 會在真的那份裡面另建一份空的，指標檔還指過去。
  所以這裡變成擋四種。搬家時目標在**現在這一份**裡面照舊報 `IO_DATA_ROOT_TARGET_INVALID` 的 `nested`（比較具體），
  在別的資料根裡面才報 `inside-data-root`。決定本身不變。
- **2026-10-11（獨立環境）**：`tools\Launch.ps1 -LocalAppData` 原本只換指標檔與使用者資料夾，第 2 步還是看這個 repo 的
  `userdata\`：平常資料放在那裡的人，獨立環境會直接打開平常那一份；沒放過的人，第一次啟動頁預選程式資料夾，
  按確定就把資料放進 repo。issue #2 的 fps 量測步驟因此會量到錯的資料。修法：獨立環境的伺服器帶
  `CYCLOSA_NO_PROGRAM_FOLDER=1`，`programRoot()` 回 `null` —— 當作沒有程式資料夾，那個選項關著，預選落到
  `<指定目錄>\Cyclosa\data`。只在 `Launch.ps1` 起 server 的那一刻帶上、起完換回來（`tests/infrastructure/isolated-environment.test.ts`）。
