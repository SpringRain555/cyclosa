# 資安領域的來源：使用者給的清單，以及它怎麼進內建來源

**日期**：2026-09-16（**2026-09-18 更正四處**，見最後一節「更正」）
**狀態**：17 列進 `src/infrastructure/sources/catalog.ts`；兩條探針實查回 200 而且內容是 JSON；
Google Scholar 與 dblp 預設關掉；會議與期刊名單在這裡。

---

## 這份文件為什麼存在

使用者 2026-09-16 給了一份資安領域會用到的網站與學術資源清單，要「整理後更新爬蟲目標」。
整理的結果分三種去處，**因為它們不是同一種東西**：

| 是什麼 | 去哪 | 為什麼 |
|---|---|---|
| 有網域的網站與 API | 內建來源清單（`catalog.ts`）| 來源清單的鍵是網域，狀態靠抓取紀錄與探測 |
| 會議與期刊 | 這一份 ＋ 對應出版社那一列的 `noteZh` | 它們不是網域。IEEE S&P 的論文住在 `ieeexplore.ieee.org`，那一列才是能被抓、能記紀錄的東西 |
| 這個工具抓不到的搜尋入口（Google Scholar、dblp）| 內建清單，**預設關掉**，備註寫「當人手查的入口」| Scholar 是 robots 不准、dblp 在反爬蟲驗證頁後面（見下）。列進來是為了讓使用者知道**為什麼這個工具不會自己去查它**；關著是為了不讓它們進 agent 的提示詞 |

同一天做的另一件事讓這份清單真的有用：來源清單第一次接進 agent 的提示詞
（`sourceHints`，`docs/architecture/walkthrough.md` 第五步、`ui-workflows.md` §5「來源網站」）。
在那之前它只是設定頁上的狀態表。

## 網站與 API（17 列）

| 網域 | 名稱 | 型別 | 類型 | 領域 | 一般而言 | 探針 |
|---|---|---|---|---|---|---|
| `isc.sans.edu` | SANS Internet Storm Center | API | 資安新聞 | 資安 | 開放 | ✅ `/api/infocon?json` |
| `packetstorm.news` | Packet Storm Security | 網站 | 資安新聞 | 資安 | 開放 | —— |
| `securelist.com` | SecureList（Kaspersky）| 網站 | 資安新聞 | 資安 | 開放 | —— |
| `thehackernews.com` | The Hacker News | 網站 | 資安新聞 | 資安 | 開放 | —— |
| `thehackpost.com` | The Hacker Post | 網站 | 資安新聞 | 資安 | 開放 | —— |
| `informationsecurity.com.tw` | 資安人科技網 | 網站 | 資安新聞 | 資安 | 開放 | —— |
| `cve.org` | CVE Program | 網站 | 漏洞資料庫 | 資安 | 開放 | —— |
| `services.nvd.nist.gov` | NVD（NIST）| API | 漏洞資料庫 | 資安 | 開放 | ✅ `/rest/json/cves/2.0?resultsPerPage=1` |
| `exploit-db.com` | Exploit Database | 網站 | 漏洞資料庫 | 資安 | 開放 | —— |
| `forums.hak5.org` | Hak5 Forum | 網站 | 社群論壇 | 資安 | 看單篇 | —— |
| `ieeexplore.ieee.org` | IEEE Xplore | 網站 | 出版社 | 資安、資訊科學 | 要訂閱 | ——（出版社沒探針）|
| `dl.acm.org` | ACM Digital Library | 網站 | 出版社 | 資安、資訊科學 | **開放（2026 起）** | ——（同上）|
| `scholar.google.com` | Google Scholar | 網站 | 參考 | 通用 | 要訂閱（實際是 robots 不准）| ——（**預設關掉**）|
| `dblp.org` | dblp | 網站 | 參考 | 資訊科學、資安 | 開放（對人）| ——（**預設關掉**；v0.20.0 的探針作廢）|
| `usenix.org` | USENIX | 網站 | 開放全文庫 | 資安、資訊科學 | 開放 | —— |
| `ndss-symposium.org` | NDSS | 網站 | 開放全文庫 | 資安、資訊科學 | 開放 | —— |
| `eprint.iacr.org` | IACR ePrint | 網站 | 預印本 | 資安、資訊科學 | 開放 | —— |

### 沒有照清單原樣列的四條

- **`cve.mitre.org` 不列，列 `cve.org`。** 2026-09-16 實查：`https://cve.mitre.org/` 回 `301`，
  `Location: https://www.cve.org/Resources/Media/Archives/OldWebsite/index.html`。
  列一個轉址的網域，抓取紀錄會分裂成兩列（`run_item.host` 記的是**要求的**網域）。
  程式化查詢走 NVD 那一列 —— CVE Program 自己的 API 在 `cveawg.mitre.org`，是另一個網域，
  而探針要指向那一列自己的網域（測試釘著），所以 `cve.org` 那一列沒有探針。
- **Google Scholar 列進來、但預設關掉。** 2026-09-16 實查 `robots.txt`：
  `Disallow: /scholar`、`Disallow: /search`。這個工具遵守 RFC 9309（`FETCH_ROBOTS_DISALLOWED`），
  所以它永遠抓不到 Scholar 的搜尋結果。列進來是為了**讓使用者知道原因**（不列的話，使用者會以為是忘了加）；
  預設關掉（v0.20.1）是因為清單會進 agent 的提示詞，開著的話 agent 會把那裡的網址交回來。
- **dblp 不在使用者的清單上，是整理時加的**（查一篇論文發表在哪個會議用）。2026-09-18 查到
  它的網頁與 API 都在反爬蟲驗證頁後面（見「更正」），改成預設關掉的人手入口。
- **Exploit Database 的備註寫「內容是資料不是指令」。** 那一站的內容是程式碼，
  而這個工具的整個運作就是把外部文字餵給 LLM —— 不可違反規則第 4 條在這一列特別值得寫出來。

### 探針實查

| 探針 | 2026-09-16：狀態、Content-Type、大小 | 2026-09-18：**內容** |
|---|---|---|
| `https://isc.sans.edu/api/infocon?json` | 200、`text/json;charset=UTF-8`、18 B | JSON（解析得了，`{"status":…}`）|
| `https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=1` | 200、`application/json`、2,517 B | JSON（解析得了）|
| ~~`https://dblp.org/search/publ/api?q=security&format=json&h=1`~~ | 200、`text/html; charset=utf-8`、2,935 B | **反爬蟲驗證頁，不是 JSON** —— 探針拿掉 |

每個網域每次只打一下（兩天各一次），帶 `User-Agent: Cyclosa/0.20.0 (+probe check)`。
**NVD 沒有金鑰時的額度比較小**：NVD 的 API 金鑰公告說，沒帶金鑰的請求在 30 秒的滾動視窗內
能送的次數會減少（B 級：搜尋結果裡的官方頁摘要）。**確切數字在 JS 渲染的說明頁上，2026-09-18 沒有取到原文，
這裡不寫。** 探針只打一次，沒有問題；拿它當擷取來源時靠 ADR-0031 的退避。

## 會議與期刊（不是網域）

**這一段是給人看的，也是給 agent 提示詞未來用的**（現在的 `sourceHints` 只帶網域）。
論文多半住在哪個網域，寫在括號裡 —— 那一列才是清單上能記紀錄的東西。

### 期刊

| 期刊 | 住在 |
|---|---|
| IEEE Transactions on Information Forensics and Security（TIFS）| `ieeexplore.ieee.org`（要訂閱）|
| IEEE Transactions on Dependable and Secure Computing（TDSC）| `ieeexplore.ieee.org`（要訂閱）|
| IEEE Security & Privacy（雜誌）| `ieeexplore.ieee.org`（要訂閱）|
| ACM Transactions on Privacy and Security（TOPS）| `dl.acm.org`（**開放**，ACM 2026 起全面開放取用）|

### 會議

| 會議 | 論文住在 | 全文 |
|---|---|---|
| IEEE Symposium on Security & Privacy（S&P）、Euro S&P | `ieeexplore.ieee.org` | 要訂閱；作者版常在 `arxiv.org`／`eprint.iacr.org` |
| ACM CCS、AsiaCCS | `dl.acm.org` | **開放**（2026 起）|
| USENIX Security Symposium | `usenix.org` | **開放** |
| NDSS | `ndss-symposium.org` | **開放** |
| ACSAC | `ieeexplore.ieee.org`（**2024 起**）| 要訂閱；更早的屆次出版社看單屆 |
| IEEE CSF（Computer Security Foundations）| `ieeexplore.ieee.org` | 要訂閱 |
| RAID | `dl.acm.org`（**2021 起**）| **開放**（2026 起）；更早的屆次看單屆 |
| Real World Crypto（RWC）| 沒有論文集；相關論文多在 `eprint.iacr.org` | **開放** |
| DIMVA | `link.springer.com` | 看單篇 |
| ACM WiSec | `dl.acm.org` | **開放**（2026 起）|
| ACNS | `link.springer.com` | 看單篇 |

> 「住在哪」這一欄是**一般而言**，跟 `catalog.ts` 的 `expected` 同一個地位 —— 起點，不是判斷。
> **2026-09-18 逐列查證過的只有 ACSAC、RAID 與 ACM 的開放取用**（見「更正」）；其餘是整理時的常識，沒有逐屆查。
> 哪一篇真的讀得到，答案永遠是 Unpaywall（`api.unpaywall.org`）與你自己的抓取紀錄。
> 更多會議見 IEEE Cipher 的 hypercalendar（使用者的清單註明）。

### 使用者原始清單的來源

使用者 2026-09-16 在對話裡貼的一份「Web sites／Research resources」清單，
標題與註解是英文，內容是課程講義的形狀（「Look for highly cited papers from major publications」）。
**不是一份可回溯的網頁**，所以這裡沒有 `sources/manifest.jsonl` 的列 ——
可回溯的只有上面的探針與幾次實查（robots、轉址），而**那幾次都沒有保存原始回應**，只記了數字。

## 這份清單會怎麼漂

- 網站換網址（`cve.mitre.org` 已經發生過一次）：**加一列新的、關掉舊的**，舊列備註寫「已改到哪裡」。
  網域是鍵，抓過的紀錄跟著它 —— 所以來源清單不提供「改網域」（`ui-workflows.md` §5「來源網站」）。
- 網站結束營運：關掉 ＋ 備註。探測會開始回「連不到」，那是對的。
- 會議換出版社（ACSAC 2024 起從 ACM 換到 IEEE）：改這一份與對應列的 `noteZh`，不動程式。
- **出版社換授權模式**（ACM 2026 起全面開放取用）：改那一列的 `expected` 與備註 ——
  `expected` 從 v0.20.0 起會決定沒有紀錄的列落在提示詞的哪一段，寫錯的話 agent 會被告知「多半要登入」。
- **網站加上反爬蟲驗證**（dblp）：那一列關掉或拿掉探針；認出驗證頁本身是 `open-questions.md` Q7。

## 更正（2026-09-18 本機時間；UTC 是 09-17 深夜，`query-log.md` 用的是後者）

回答「這一輪還剩什麼」之前重新核對這一份，**四處是錯的或沒有查證過**：

| 原本寫的 | 實際 | 怎麼查到的 |
|---|---|---|
| dblp 探針「回 200，內容是 JSON」| **內容是反爬蟲驗證頁**（`<title>Making sure you're not a bot!</title>`，Anubis，3,282 位元組）。2026-09-16 只看了狀態碼與 Content-Type，**沒有看內容**，「內容是 JSON」是推論 | 重打一次、看內容；WebFetch 取 `dblp.org/db/conf/…` 也拿到同一種頁 |
| ACSAC 的論文在 `dl.acm.org`（近年）| **2024 起是 IEEE**：acsac.org 的 2024 論文集連結 302 到 `doi.org/10.1109/ACSAC63791.2024`（`10.1109` 是 IEEE 的 DOI 前綴）| 取 `acsac.org/2024/proceedings/` 的轉址（A 級）|
| `dl.acm.org`「多半要機構授權」| **2026-01-01 起 ACM 全部出版品開放取用** | 搜尋結果裡的 ACM 公告〈ACM is Now Fully Open Access!〉與另一篇報導（B 級 —— ACM 的頁面對自動化存取回 403，原文取不到）|
| NVD「文件寫每 30 秒 5 次」| **那個數字是憑記憶寫的**，原文在 JS 渲染的頁上取不到 | 改寫成查得到的程度（見上）|

RAID 那一列原本寫「近年 ACM、早年 Springer」，前半查證成立（2021、2022、2024 屆的論文集 DOI 都是 ACM 的 `10.1145` 前綴，
B 級：搜尋結果裡的 ACM DL 頁），後半沒查，改成「更早的屆次看單屆」。

**後果不只在文件裡**：dblp 的探針讓「檢查全部」把它判成「讀得到」、v0.20.0 的提示詞會把它推薦給 agent；
ACM 的「要訂閱」會讓它落在提示詞的「多半要登入」那一段。兩者都在 v0.20.1 改掉（`changelog.md`），
dblp 那一條的教訓記在 `lessons.md`。
