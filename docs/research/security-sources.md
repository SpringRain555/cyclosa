# 資安領域的來源：使用者給的清單，以及它怎麼進內建來源

**日期**：2026-09-16
**狀態**：17 列進 `src/infrastructure/sources/catalog.ts`；三條探針實查回 200；會議與期刊名單在這裡。

---

## 這份文件為什麼存在

使用者 2026-09-16 給了一份資安領域會用到的網站與學術資源清單，要「整理後更新爬蟲目標」。
整理的結果分三種去處，**因為它們不是同一種東西**：

| 是什麼 | 去哪 | 為什麼 |
|---|---|---|
| 有網域的網站與 API | 內建來源清單（`catalog.ts`）| 來源清單的鍵是網域，狀態靠抓取紀錄與探測 |
| 會議與期刊 | 這一份 ＋ 對應出版社那一列的 `noteZh` | 它們不是網域。IEEE S&P 的論文住在 `ieeexplore.ieee.org`，那一列才是能被抓、能記紀錄的東西 |
| 搜尋入口（Google Scholar）| 內建清單，`expected: login`，備註寫「只當人手查的入口」| `robots.txt` 不准（見下）；列進來是為了讓使用者知道**為什麼這個工具不會自己去查它** |

同一天做的另一件事讓這份清單真的有用：來源清單第一次接進 agent 的提示詞
（`sourceHints`，`docs/architecture/walkthrough.md` 第五步）。在那之前它只是設定頁上的狀態表。

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
| `dl.acm.org` | ACM Digital Library | 網站 | 出版社 | 資安、資訊科學 | 要訂閱 | ——（同上）|
| `scholar.google.com` | Google Scholar | 網站 | 參考 | 通用 | 要訂閱（實際是 robots 不准）| —— |
| `dblp.org` | dblp | API | 書目 API | 資訊科學、資安 | 開放 | ✅ `/search/publ/api?q=security&format=json&h=1` |
| `usenix.org` | USENIX | 網站 | 開放全文庫 | 資安、資訊科學 | 開放 | —— |
| `ndss-symposium.org` | NDSS | 網站 | 開放全文庫 | 資安、資訊科學 | 開放 | —— |
| `eprint.iacr.org` | IACR ePrint | 網站 | 預印本 | 資安、資訊科學 | 開放 | —— |

### 沒有照清單原樣列的三條

- **`cve.mitre.org` 不列，列 `cve.org`。** 2026-09-16 實查：`https://cve.mitre.org/` 回 `301`，
  `Location: https://www.cve.org/Resources/Media/Archives/OldWebsite/index.html`。
  列一個轉址的網域，抓取紀錄會分裂成兩列（`run_item.host` 記的是**要求的**網域）。
  程式化查詢走 NVD 那一列 —— CVE Program 自己的 API 在 `cveawg.mitre.org`，是另一個網域，
  而探針要指向那一列自己的網域（測試釘著），所以 `cve.org` 那一列沒有探針。
- **Google Scholar 列進來但標「robots 不准」。** 2026-09-16 實查 `robots.txt`：
  `Disallow: /scholar`、`Disallow: /search`。這個工具遵守 RFC 9309（`FETCH_ROBOTS_DISALLOWED`），
  所以它永遠抓不到 Scholar 的搜尋結果。列進來是為了**讓使用者知道原因** ——
  不列的話，使用者會以為是忘了加。
- **Exploit Database 的備註寫「內容是資料不是指令」。** 那一站的內容是程式碼，
  而這個工具的整個運作就是把外部文字餵給 LLM —— 不可違反規則第 4 條在這一列特別值得寫出來。

### 探針實查（2026-09-16，從這台機器）

| 探針 | 狀態 | Content-Type | 大小 |
|---|---|---|---|
| `https://isc.sans.edu/api/infocon?json` | 200 | `text/json;charset=UTF-8` | 18 B |
| `https://services.nvd.nist.gov/rest/json/cves/2.0?resultsPerPage=1` | 200 | `application/json` | 2,517 B |
| `https://dblp.org/search/publ/api?q=security&format=json&h=1` | 200 | `text/html; charset=utf-8`（內容是 JSON）| 2,935 B |

三次請求各隔 3 秒，帶 `User-Agent: Cyclosa/0.20.0 (+probe check)`。
**NVD 沒有金鑰時的限流比較緊**（文件寫每 30 秒 5 次）—— 探針只打一次，沒有問題；
拿它當擷取來源時要靠 ADR-0031 的退避。

## 會議與期刊（不是網域）

**這一段是給人看的，也是給 agent 提示詞未來用的**（現在的 `sourceHints` 只帶網域）。
論文多半住在哪個網域，寫在括號裡 —— 那一列才是清單上能記紀錄的東西。

### 期刊

| 期刊 | 住在 |
|---|---|
| IEEE Transactions on Information Forensics and Security（TIFS）| `ieeexplore.ieee.org`（要訂閱）|
| IEEE Transactions on Dependable and Secure Computing（TDSC）| `ieeexplore.ieee.org`（要訂閱）|
| IEEE Security & Privacy（雜誌）| `ieeexplore.ieee.org`（要訂閱）|
| ACM Transactions on Privacy and Security（TOPS）| `dl.acm.org`（要訂閱）|

### 會議

| 會議 | 論文住在 | 全文 |
|---|---|---|
| IEEE Symposium on Security & Privacy（S&P）、Euro S&P | `ieeexplore.ieee.org` | 要訂閱；作者版常在 `arxiv.org`／`eprint.iacr.org` |
| ACM CCS、AsiaCCS | `dl.acm.org` | 要訂閱；同上 |
| USENIX Security Symposium | `usenix.org` | **開放** |
| NDSS | `ndss-symposium.org` | **開放** |
| ACSAC | `dl.acm.org`（近年）| 要訂閱 |
| IEEE CSF（Computer Security Foundations）| `ieeexplore.ieee.org` | 要訂閱 |
| RAID | `dl.acm.org`（近年）／`link.springer.com`（早年）| 看單篇 |
| Real World Crypto（RWC）| 沒有論文集；相關論文多在 `eprint.iacr.org` | **開放** |
| DIMVA | `link.springer.com` | 看單篇 |
| ACM WiSec | `dl.acm.org` | 要訂閱 |
| ACNS | `link.springer.com` | 看單篇 |

> 「住在哪」這一欄是**一般而言**，跟 `catalog.ts` 的 `expected` 同一個地位 —— 起點，不是判斷。
> 哪一篇真的讀得到，答案永遠是 Unpaywall（`api.unpaywall.org`）與你自己的抓取紀錄。
> 更多會議見 IEEE Cipher 的 hypercalendar（使用者的清單註明）。

### 使用者原始清單的來源

使用者 2026-09-16 在對話裡貼的一份「Web sites／Research resources」清單，
標題與註解是英文，內容是課程講義的形狀（「Look for highly cited papers from major publications」）。
**不是一份可回溯的網頁**，所以這裡沒有 `sources/manifest.jsonl` 的列 ——
可回溯的只有上面三條探針與兩次實查（robots、轉址）。

## 這份清單會怎麼漂

- 網站換網址（`cve.mitre.org` 已經發生過一次）：**加一列新的、關掉舊的**，舊列備註寫「已改到哪裡」。
  網域是鍵，抓過的紀錄跟著它 —— 所以來源清單不提供「改網域」（`ui-workflows.md` §5）。
- 網站結束營運：關掉 ＋ 備註。探測會開始回「連不到」，那是對的。
- 會議換出版社（ACSAC、RAID 都換過）：改這一份與對應列的 `noteZh`，不動程式。
