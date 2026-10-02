# 對外抓取的節奏

**這份是「多久抓一次、被限流了怎麼辦」的理由。** 數字的正本在兩個檔：
`src/domain/ingest/throttle.ts`（擷取管線）與 `src/domain/provider/rate-limit.ts`（LLM 端點）。
下面那張設定值表由 `tests/guards/fetch-policy.test.ts` 逼著與程式一致 ——
**改數字改程式，這張表跟著改**，漏了一邊測試會紅。

> CONVENTIONS §17：擷取紀律只有三條絕對線，**速率與重試是設定值，住在做抓取的那份程式裡**，
> 規則文件不寫數字。這一份不是規則文件，它是那些數字的理由 —— 理由散在五個檔的註解裡，
> 下一個想改數字的人就找不到它們。

## 不可談的三條（沒有數字）

1. **不繞過付費牆、登入、CAPTCHA 或任何存取控制。** 401／403 是 `FETCH_LOGIN_REQUIRED`，
   交給人自己去讀，不是一個可以「想辦法」的失敗。
2. **遵守 `robots.txt`（RFC 9309）。** 4xx ＝ 沒有規則 ＝ 可以抓；5xx ＝ 拿不到 ＝ 全部不准 ——
   兩者方向相反，而它們很容易被寫成同一條。`Crawl-delay` 比我們的間隔長就聽它的，
   比我們短就忽略（我們不會因為對方說「可以快一點」就加速）。**轉址的每一跳都重問。**
3. **抓回來的是資料不是指令；每一次抓取都留出處**（快照的 SHA-256、`manifest.jsonl`）。

這三條在 agent 檔的「五條不可違反的規則」裡。下面的一切都是設定值。

## 回來的是驗證頁，不是內容（v0.21.0，open-questions Q7 的答案）

**狀態碼不是內容的證據。** 反爬蟲的驗證頁多半回 **HTTP 200** —— 對瀏覽器來說它確實成功了，
那一頁本來就是要被執行的。對這個工具來說它是最糟的一種失敗：**安靜地**把驗證頁的文字
當成正文存進專題，而且來源清單會因為這一次「成功」把那個站往前排。

判斷在 `src/domain/ingest/challenge.ts`（純函式），呼叫點在 `fetcher.ts` ——
**因為只有那一層看得到標頭**。三層，由強到弱：

| 層 | 依據 | 結論 | 為什麼可靠 |
|---|---|---|---|
| 1 | **要的型別與拿到的型別矛盾**：探測問的是一支 API，回來的是 `text/html` | `challenge` | **零猜測**，不需要認得任何反爬蟲產品 |
| 2 | **廠商自己宣告的信號**：`cf-mitigated: challenge`（Cloudflare 官方文件）、頁面裡的 Anubis 標記 | `challenge` | 是產品自己放上去表明身分的東西 —— **但這是一份會過期的清單**，每一條都要帶出處與日期 |
| 3 | HTML ＋ 自稱 `noindex` ＋ 小於 20 KB ＋ `no-store`，**四個同時成立** | `suspect` | 最弱，所以**永遠不下定論**：不存，但理由說成「不確定，你自己看一眼」 |

三件要記住的：

- **401／403 現在有兩種。** 帶廠商標頭的是 `FETCH_BOT_CHALLENGE`（對方擋工具，**登入沒有用**），
  其餘仍然是 `FETCH_LOGIN_REQUIRED`（要訂閱）。**沒有依據就不猜** —— 給使用者的下一步完全不同。
- **`looksJsOnly` 看不到驗證頁。** 它要 HTML ≥ 20,000 字元才談得上判斷，而驗證頁遠比那小
  （實測 dblp 那一張 7,489 bytes）。第三層補的就是那個洞。
- **刻意不列標題字串**（「Just a moment…」那種）。Q2 的教訓是憑印象列的標記清單在真實頁面上
  命中 0 次，而標題會隨產品改版與語系變，出處也無法查證。

**這不是「繞過」** —— 工具不解任何驗證、不換身分重試。認出來之後的動作是記一筆、
標成「對方出驗證頁」（來源清單的 `challenged`），並叫使用者自己用瀏覽器拿。

> **順序上，robots 比這一層更早。** 2026-09-18 走 `Crawler` 實跑 dblp 的探針，
> 回的不是驗證頁而是 `FETCH_ROBOTS_DISALLOWED` —— 它的 `robots.txt` 是
> `User-agent: *` ＋ `Disallow: /`，**請求根本沒有送出去**。
> 也就是說：**引發這一整條規則的那個網站，其實在更前面一關就停了**。
> 這一層守的是「robots 說可以、對方卻回一張驗證頁」的那些站。

## 設定值

| 常數 | 值（毫秒或次數） | 為什麼是這個數字 |
|---|---|---|
| `MIN_INTERVAL_MS` | 1000 | 同網域間隔的下限。設定再小也不會低於它 —— **夾住是規則**，下限本身是設定值 |
| `DEFAULT_INTERVAL_MS` | 3000 | 與 webscouts 的預設相同。它 2026-08-27 從 1 秒調到 3 秒，理由是「每秒一個請求比這些站需要被問的頻率都快」，而量過的代價很小（瓶頸是往返延遲，不是間隔）|
| `MAX_RATE_LIMIT_RETRIES` | 2 | 同一個 URL 被限流之後最多再試幾次。與 Scrapy 的 `RETRY_TIMES` 預設相同 |
| `DEFAULT_BACKOFF_MS` | 5000, 15000 | 對方沒給 `Retry-After` 時，第一次、第二次重試前等多久。比間隔長一個量級 —— 「對方剛說慢一點」比我們自己的節奏更該聽 |
| `MAX_RETRY_AFTER_MS` | 60000 | 對方要我們等更久，這一輪就不等了：一個作業對著一個網站乾等兩分鐘，使用者看到的是「卡住」 |
| `PROVIDER_MAX_RETRIES` | 2 | LLM 端點回 429 之後最多再試幾次。官方 SDK 的慣例 |
| `PROVIDER_BACKOFF_MS` | 500, 1000 | 沒有 `Retry-After` 時：0.5 秒 × 2ⁿ，官方 SDK 的形狀 |
| `PROVIDER_MAX_RETRY_AFTER_MS` | 60000 | 一次任務不為一個端點卡一分鐘以上 |

**同網域間隔可以用環境變數 `CYCLOSA_FETCH_INTERVAL_MS`（毫秒）調** —— 它是這台機器上的決定
（某個站要求別吵、機器在計量網路上），不是專題的屬性。沒設用預設；小於下限一律夾到下限，
**設成 0 不會變成 0**；不是數字當成沒設。現在的值在設定頁「狀態說明」的「對外抓取的規矩」，
數字從 `GET /api/system/fetch-policy` 讀，不寫死在畫面字串裡。「匯入與研究」只在抓取等待時顯示正在等的網域與時間。

## 被限流的時候：擷取管線

1. 對方回 **429 或 503**（對 `robots.txt` 本身回也算）→ 讀 `Retry-After`：秒數或 HTTP-date，
   **讀不出來就當沒有**（一個寫壞的標頭不該讓我們比沒有標頭時更急）
2. 有 → **照它等，不打折**（比我們的預設短也照它的，那是它的意願）；沒有 → `DEFAULT_BACKOFF_MS` 的第 n 個；
   要等的比 `MAX_RETRY_AFTER_MS` 長 → 放棄
3. 等完**同一個 URL 再試** —— 仍然先過同網域間隔；最多 `MAX_RATE_LIMIT_RETRIES` 次
4. 還是不行 → 這一項記 `FETCH_RATE_LIMITED`（**可重排**，不是這個 URL 的問題，是時機的問題），
   **這個 host 進這一輪的放棄名單**（`Crawler.limitedHosts`）。之後排到它的項目**不送任何請求**，
   直接記同一個碼（`detail.why` 是 `host-limited`）—— **轉址的每一跳都查**，所以短網址繞不過去
5. **其他 host 照跑。** 整批停下來只有一個原因：使用者取消（退避中也聽得到，每 250 毫秒看一次）

「這一輪」是一台 `Crawler` 的壽命：一次匯入、一次研究蒐集、一次來源檢查各自一台。
等待的時間（節流 ＋ 退避）都算進 `run_item.waited_ms` —— REQ-0003 的「可量測」量的就是它。

## 被限流的時候：LLM 端點

OpenAI 相容端點回 429 → 讀 `Retry-After`；沒有就 `PROVIDER_BACKOFF_MS`；最多 `PROVIDER_MAX_RETRIES` 次；
還是 429 才回 `PROVIDER_RATE_LIMITED`。**逾時是整次呼叫的預算，含退避的等待** ——
不是每一次重試各自一份，否則「180 秒逾時」會變成九分鐘。

**為什麼比擷取管線急**：對方是一個賣 API 的服務，429 是它的流量整形 —— 端點回 429 的意思是「排隊」；
別人的網站才需要禮貌地慢。形狀照 OpenAI 官方 Node SDK（2026-09-13 對照它的 `src/client.ts`：
預設最多重試 2 次；429 會重試；`Retry-After` 在 0～60 秒之內就照它的，否則 0.5 秒 × 2ⁿ、上限 8 秒、
加最多 25% 的 jitter）。Anthropic 的 SDK 沒有對照過。三處刻意不同：

- **`Retry-After` 超過上限就放棄**，不是改用自己的退避 —— 對方要我們等五分鐘時照 0.5 秒重試，
  等於沒在聽
- **不加 jitter** —— 這是單一使用者的本機工具，沒有一群客戶端同時重試的問題
- **不讀 `retry-after-ms`**（OpenAI 自己的非標準標頭）—— 沒有它的時候退回預設退避，那也正是 SDK 的預設

本機 Ollama 的原生協定沒有限流，這一段不適用。

## 為什麼是現在這個形狀（2026-09-13，ADR-0031）

2026-09-13 之前，這個專案把「同網域至少三秒、被限流就整批停下、不看 `Retry-After`」寫成
**不可違反的規則**。那段話是 `~\.claude\CLAUDE.md` 裡 **agent 替人做調查時的姿態**，被逐字抄進了
產品的正確性條件。三個問題：

| 問題 | 根據 |
|---|---|
| **比所有人都嚴，而且嚴的理由沒有量過** | Scrapy 預設 `DOWNLOAD_DELAY=0`（要禮貌就開 AutoThrottle）、`RETRY_TIMES=2` 且重試碼含 429／503；RFC 6585／9110 為這兩個碼定義了 `Retry-After`，意思就是「等這麼久再來」 |
| **一個網站限流讓整批停，保護的對象錯了** | 2026-09-08 第一次按「檢查全部」：Semantic Scholar 回 429，排在後面的 Europe PMC、PubMed、Unpaywall 一個都沒被檢查，畫面上顯示「還沒有依據」，看起來像沒事（`source-service.ts`） |
| **LLM 端點一次 429 讓整個任務作廢** | **這一條是推論，不是事件** —— 線上端點在這台機器上一個都還沒量過（v0.18.0 的第一條收尾條件是 🟡）。但擴展的預算是十分鐘、十幾次呼叫，而線上服務的 429 是日常的流量整形 |

**沒有變的**：預設間隔（3 秒）、robots 的判讀、快照與 manifest、「擷取管線是唯一出口」、
401／403 不繞過。變的只有「被限流之後」與「數字住在哪」。

## 與 webscouts 的對照

| | cyclosa | webscouts |
|---|---|---|
| 同網域預設間隔 | 3 秒（`CYCLOSA_FETCH_INTERVAL_MS`） | 3 秒（`WEBSCOUTS_GLOBAL_RATE_LIMIT`；圖床車道 1 秒） |
| 車道的單位 | **hostname** | registrable domain（`zh.` 與 `storage.` 同一條） |
| 被限流 | 退避重試兩次，仍失敗記碼可重排，那個 host 這一輪放棄，其他照跑 | 記 `ERR_RATE_LIMIT`，可重排 |
| 數字住在哪 | `domain/ingest/throttle.ts` | `infrastructure/network/bandwidth.py` |

**車道單位是一個已知的差別，2026-09-13 改成退避重試時沒有動它**：cyclosa 用 hostname 分車道，
所以同一個站的 `www.` 與 `static.` 會各拿一條、收到兩倍請求。webscouts 的
`docs/architecture/download-pacing.md` 講過這件事並用 registrable domain 分車道。
要跟上的時候，改的是 `Crawler` 交給 `HostThrottle` 與放棄名單的那個鍵（現在就是 hostname）——
`domain/ingest/url.ts` 有一支 `throttleKey`，**但 2026-09-13 查過沒有任何人呼叫它**；
而且要一份公共後綴清單（`com.tw` 是兩段）。

## 什麼不在這裡

- robots 的解析規則 → `src/domain/ingest/robots.ts`
- 快照、manifest、衍生物的關係 → [`storage-layout.md`](storage-layout.md)
- 每個錯誤碼使用者該做什麼 → [`error-codes.md`](error-codes.md)
- agent 找到的網址怎麼回到管線 → ADR-0006
