# 發布前檢查表

**這份只放「人才能判斷」的項目。** 自動測試涵蓋的東西不寫在這裡 ——
那些歸 `Verify.ps1`，重複列一次只會讓兩邊分岔。

> **`Test-PublishReadiness.ps1` 全過不等於可以公開。**
> 它只保證機器能查的那幾類沒問題（CONVENTIONS §13）。**下面這些它查不到。**

> **現況（2026-09-06）**：這個專案 `remote: none`，**還沒有要公開**。
> 這份表存在是為了讓「要公開的那一天」不用臨時想 ——
> **不是待辦清單。** 每一項的「現況」欄說明它現在能不能檢查。

---

## 先跑自動的那一輪

```powershell
.\Verify.ps1                                    # lint + typecheck + test + 四條守門
D:\Projects\_meta\scripts\Test-PublishReadiness.ps1 -Slug cyclosa
```

`Test-PublishReadiness.ps1` 掃：個資格式、寫死的私人路徑、金鑰與 `.env`、
`LICENSE` 存不存在、README 的未填佔位符、`.gitignore` 涵蓋度。

**它會掃 git 歷史，不只工作區** —— 私人路徑一旦進過 commit 就永遠在那裡，
把工作區清乾淨完全沒有用（`git log -S` 是唯一問得出來的方法）。

---

## A · 個資與私人路徑（人工）

| # | 檢查 | 現況 |
|:--:|---|---|
| A1 | **文件裡的 `<資料根目錄>`／`<私人資料樹>` 佔位符沒有一個被換成真路徑** —— 包括新寫的文件 | ✅ 現在就能查 |
| A2 | **截圖裡沒有真實路徑、專題名稱、視窗標題列或其他視窗** —— 這是腳本永遠查不到的 | ⬜ 還沒有截圖 |
| A3 | **`docs/environment/snapshots/` 的環境快照已去識別化**：沒有使用者名、機器名、絕對路徑 | ⬜ 還沒有快照 |
| A4 | **`.claude/settings.json` 沒進版控**（範本 `settings.example.json` 才進） | ✅ 現在就能查 |
| A5 | **測試用的固定資料裡沒有真實來源內容** —— 合成資料要看得出來是合成的 | ⬜ 還沒有測試 |
| A6 | **`docs/research/sources/manifest.jsonl` 裡沒有帶身分的 URL**（含 token 的網址、私人分享連結） | ✅ 現在就能查 |
| A7 | **設計稿的 artifact URL 沒有進 repo** —— 它是私有的，放進來只會是一條別人打不開的連結 | ✅ 現在就能查 |

## B · 授權（人工）

| # | 檢查 | 現況 |
|:--:|---|---|
| B1 | **`package.json` 的每一個相依都實查過 `LICENSE`**，結果記在 `docs/environment/versions.md` | ⬜ 還沒有 `package.json` |
| B2 | **沒有任何 AGPL-3.0 的程式碼或依賴**（Datashare／SingleFile／Karakeep／Linkwarden／Zotero） | ✅ 現在就能查 |
| B3 | **不能只信 GitHub API 的 `license` 欄** —— Zotero 就是反例（API 回 `NOASSERTION`，要開 `COPYING`）。**API 說「不知道」的時候，答案不是「沒有授權」** | ✅ 規則已成文 |
| B4 | **借來的概念都標明「借的是概念還是程式碼」**（`docs/research/market-scan.md`） | ✅ 現在就能查 |
| B5 | **從別的專案複製過來的檔案**（例如 CSS token）**在複製的 commit 訊息裡寫明它是複本** | ⬜ 還沒複製 |

## C · 文件誠實度（人工）

**這一項是這個專案的特有風險，別的專案沒有。**

| # | 檢查 | 現況 |
|:--:|---|---|
| C1 | **`docs/index.md` 的現況欄逐檔確認過**，不是照計畫填 | ✅ 現在就能查 |
| C2 | **README 與 agent 檔沒有用現在式描述任何不存在的指令** —— `rubricator` 就是這樣長出一份叫人執行不存在的 `Verify.cmd` 的 agent 檔 | ✅ 現在就能查 |
| C3 | **`market-scan.md` 的每一條都標了日期與級別**，新舊結論分得出來 | ✅ 現在就能查 |
| C4 | **`lessons.md` 沒有刪過條目**（append-only） | ✅ 現在就能查 |
| C5 | **每份 ADR 的「代價」與「什麼情況要重新考慮」都不是空的** | ✅ 現在就能查 |

## D · 執行期行為（人工，要真的跑一次）

| # | 檢查 | 現況 |
|:--:|---|---|
| D1 | **從一個乾淨的 clone ＋ 空的資料根跑一次一鍵啟動**，全程不看文件也走得完 | ⬜ 還不能跑 |
| D2 | **故意弄壞指標檔**，畫面要說得出「指標檔在哪、指到哪、那個路徑怎麼了」 | ⬜ 還不能跑 |
| D3 | **拔掉網路跑一次** —— 除了主動抓取以外的功能要照常，錯誤訊息要說得清楚 | ⬜ 還不能跑 |
| D4 | **停掉 Ollama 跑一次語意檢索** —— 要報能力不足並停手，**全文檢索照常** | ⬜ 還不能跑 |
| D5 | **診斷匯出的檔案人工看過一遍**，確認裡面沒有來源內容、筆記內容或絕對路徑 | ⬜ 還不能跑 |
| D6 | **節流真的有 3 秒** —— 看日誌的時間戳序列，不是看程式碼 | ⬜ 還不能跑 |

## E · 卡片與 registry（人工）

| # | 檢查 |
|:--:|---|
| E1 | `_meta\cards\cyclosa.md` 的 `remote`／`remote_url`／`visibility` 三欄填對 |
| E2 | 跑 `_meta\scripts\Update-Dashboard.ps1`，**不手改 `dashboard.md` 與 `registry.json`** |
| E3 | registry 的 `issues` 是 0 |

---

## 兩件不在這張表上、但要記得的

1. **公開是不可逆的。** 已經以 MIT 發佈的版本改不回來（ADR-0012 的代價），
   而私人路徑一旦進過歷史就永遠在那裡。**這張表全過再按，不要反過來。**
2. **`remote: none` 的專案被 `Test-PublishReadiness.ps1` 報的維運區 warning 是真陽性。**
   它如實說出「還沒準備好公開」。消掉它的時機是真的要公開的時候。
