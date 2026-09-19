# ADR-0034 OpenAI 相容 API 走 Responses API；找來源可以走它的搜尋工具

- 狀態：**已採納**（2026-09-19，v0.24.2）
- 依據：2026-09-19 使用者看過 v0.24.1 的設定頁之後問的六點，其中「OpenAI 相容端點不能上網嗎？
  我原本是預期讓它做這件事（模型新、一次燒得了的額度大）」；同一天的兩句補充：
  「好像有支援 web search 只是沒試過」「調用時用 responses format，不要用 chat format」
- 延續：ADR-0030（格式保證是量的）、ADR-0032（任務 → 連線 ＋ 模型）、ADR-0006（agent 不抓）

## 背景

v0.24.1 之前，「找候選來源」只能走 Claude Code：那是唯一一條會上網的路（`--tools WebSearch`）。
OpenAI 相容 API 這一條路我們只送 Chat Completions（`/chat/completions`），模型碰不到網路，
只能憑記憶給網址 —— 而一個憑記憶給的網址，正是找來源這一步要取代的東西。

使用者的分工想法是把大量、要燒額度的事交給他那一條 OpenAI 相容端點（Codex 訂閱的代理）。
2026-09-19 對那一條端點量了四次（`research/openai-responses-web-search.md`）：

| 量什麼 | 結果 |
|---|---|
| `POST /responses` 帶 `tools: [{type: 'web_search'}]`，**不串流** | HTTP 200，`tool_usage.web_search.num_requests` 是 1，**但 `output` 是空的** |
| 同一個請求，**串流** | 事件流裡有 `web_search_call`（查詢字串看得到）、一則帶引用的回答，4.7 秒 |
| 串流 ＋ `text.format` 的 json_schema ＋ `tool_choice: 'required'` | 搜了、交回符合 schema 的 JSON，9.4 秒 |
| 用找來源**真的會送的**系統提示與 schema（O-RAN WG11 的題目）| 搜了 2 次（8 條查詢）、6 條候選全是 o-ran.org 的官方頁，19 秒 |

另外：`/responses` 不帶工具、不串流也回空的 `output`；`temperature: 0` 收；`max_output_tokens` 被忽略；
本機 Ollama 的 `/v1/responses` 也存在（HTTP 200）。

## 決定

### 一、找來源可以走 OpenAI 相容 API（`agent-openai.ts`）

`viaOptionsOf('find-sources')` 從 `['cli']` 變成 `['cli', 'openai']`。走 OpenAI 相容 API 的時候，
一次找來源是一個 `POST /responses`：`instructions` 是同一份 `SOURCES_SYSTEM`、`input` 是同一份提示詞、
`tools` **只有 `web_search` 一個**、`tool_choice: 'required'`、`text.format` 是 `SOURCES_SCHEMA`（`strictify` 過）。

- **規則跟 Claude Code 那一支一樣**：只給搜尋。沒有程式執行、沒有檔案、沒有函式。
  搜尋在對方的伺服器上跑（模型可能在那邊讀到頁面內容 —— Claude 的 WebSearch 也是），
  **不從這台機器抓任何東西**，進專題的東西只走擷取管線（ADR-0006 第 5 條不變）。
- 一次 HTTP 呼叫寫不了檔，沙箱對它永遠是空的；呼叫端照樣掃，不為它開例外。
- **一定要搜尋。** 回應裡沒有一筆完成的 `web_search_call` 就不採用那一次（`PROVIDER_CAPABILITY_MISSING`）：
  沒搜尋就交回的網址只可能來自記憶。

### 二、「會不會上網搜尋」是量的，不是宣告的（跟 ADR-0030 同一套）

每個端點＋模型量一次（一個帶搜尋的小請求：「找出 Node.js 官方下載頁的網址」，只回一個 `url`），
**真的搜尋了、交回的形狀也對**才算會；帶著時間記在 `provider-checks.json`（鍵前面多一段 `browse|`）。
還沒量的時候放行；**開始擴展之前先量**（`expand-service` 勾選那一步，量出不會就停手、一個網址都不抓）；
設定頁「儲存並測試」對找來源那一列量的就是這件事。

Claude Code 那一支沒有這個量測：它的搜尋是我們給它的參數，設定頁那一行寫「由參數保證」。

### 三、OpenAI 相容 API 的對話也先走 Responses API，沒有那條路才退回 Chat Completions

使用者指定了 Responses API；而同一條端點兩種協定等於同一件事兩份量測。所以 `chat-openai.ts` 的
量測第一個請求先打 `/responses`（`text.format` 的 json_schema）：回 404／405／501 的端點記成 `chat`、
改打 `/chat/completions` 再問一次；其餘照 ADR-0030 的三級（`schema`／`object`／`none`）量。
**量的時候走的協定記在量測裡**（`JsonCheck.protocol`），設定頁「格式保證」那一行跟著寫
（「由端點保證（json_schema） · Responses API」）。

- **v0.24.1 之前的量測沒有 `protocol` 欄位，讀到就當沒量過**：那些是對 Chat Completions 量的，
  同一個端點要重量一次（一到兩個小請求）。
- **Responses API 上一律串流**：使用者那一條代理不串流的時候回 `output: []`。
  內容以 `response.output_item.done` 的 message 為準（`response.completed` 裡的 `output` 也是空的）；
  對方若不理會 `stream` 而回一整份 JSON，也照樣讀（`responses-api.ts`）。
- 量過 Responses API、之後那條路不見了（404）→ 跟「量過 json_schema、現在被拒」同一種處理：
  說量測可能舊了、叫人到設定頁重新檢查，**不自己換協定重送**。

### 四、設定頁的名字與兩顆按鈕（使用者 2026-09-19 挑的）

| 原本 | 現在 | 為什麼 |
|---|---|---|
| 「每個任務用哪條連線的哪個模型」 | **模型分工** | 四個字說的就是「哪個模型做哪件事」 |
| 「連線」（區標題、欄名）| **模型服務**／欄名「服務」 | 說的是它「是什麼」：模型從哪一種服務來；Claude Code 也套得上 |
| 「Claude Code CLI」「本機 Ollama」「OpenAI 相容端點」 | **Claude Code**、**Ollama**、**OpenAI 相容 API** | 三塊都是產品名；「本機或線上、花不花錢」寫在名字底下那一行 |
| 「連線並列出模型」（只有兩塊有）| **儲存並檢查**（三塊都有）| 先存這一塊，再看連不連得上、有哪些模型；**不花錢** |
| 逐列「實際打一次」 | **儲存並測試**（「模型分工」右上角一顆）| 先存這一頁，再對每一個設好的任務真的打一次，逐列寫結果；會花錢的先講 |

三塊「模型服務」各自框起來，標題列同一個形狀（名字、一行「在哪裡跑、花不花錢」、現況、按鈕）。
Ollama 那一塊的說明回答了使用者問的「開著就能用嗎、要設 port 嗎」：開著就能用，預設位址就是它的預設埠 11434，
只有改過 `OLLAMA_HOST` 才需要改。

## 考慮過、沒有選的

| 選項 | 為什麼沒選 |
|---|---|
| **Cyclosa 自己接一個搜尋服務**（Tavily、Brave、Exa、Parallel、Firecrawl 這一類）| 使用者一開始以為端點不支援搜尋時提的。量過之後端點自己就會搜，而自己接一個服務要另一把金鑰、另一份條款、另一組節流；這台機器上一把那些服務的金鑰都沒有。市面上的比較（2026-09：Exa／Tavily 在 agent 用途的評分最高、Brave 最快、Parallel 在 BrowseComp／SimpleQA 上準確度最高）留在調查裡，需求出現再選 |
| **學術搜尋 API**（OpenAlex、Semantic Scholar，免費、不用金鑰）| 對論文型專題可能比一般搜尋準得多（DOI、引用關係）。它不是「找來源」的替代，是另一種來源；放進「研究」的設計裡（Stage 20 的候選清單可以多一條學術來源的路），這一版不做 |
| **Chat Completions 的 `web_search_options`**（OpenAI 自家的 search-preview 模型才有）| 是模型限定的，不是協定的一部分；使用者那一條端點的模型清單裡沒有 search-preview |
| **只做找來源走 Responses API，對話留在 Chat Completions** | 同一條端點兩種協定、兩份量測；而使用者明說「不要用 chat format」 |
| **Responses API 也不串流** | 使用者那一條代理不串流回空的 `output`（帶不帶工具都一樣），沒有別的讀法 |
| **在 Responses 上被拒就自動換 Chat Completions 重送** | 那是靜默降級（ADR-0006 第 3 條）：結果會來自一組跟畫面上顯示的不同的條件。只有 404（沒有那條路）才退，而且記下來 |

## 代價

- **同一個端點多量一次**（v0.24.1 之前的量測作廢）：一到兩個小請求，第一次跑任務或按「儲存並測試」時發生。
- **`provider-checks.json` 裡有兩種紀錄**（JSON 格式、搜尋），寫其中一種時另一種要原樣留著 ——
  `json-checks.ts` 改成「換一個鍵、其餘寫回」；舊的「讀出認得的、整份寫回」會把另一種洗掉。
- **找來源走線上端點的花費算不出來**：這個協定不回報金額，`costUsd` 是 `null`（不知道，不是 0）；
  上限只剩時間與網址數。
- **`temperature: 0` 兩條協定都送**。OpenAI 自家的推理模型會拒收它（HTTP 400），那時候量測會說
  「json_schema 被拒」而理由其實是 temperature —— 詳細內文在 `detail` 裡看得到。使用者那一條代理收；
  真的撞到再改（見下面）。

## 什麼情況要重新考慮

- 有人真的把 Cyclosa 接到 OpenAI 自家的 API 而量測回 400 提到 `temperature` → 對 Responses API 不送 `temperature`
  （或先量一次收不收）。
- 使用者要一條**跟模型端點無關**的搜尋（例如端點的搜尋品質不夠、或想用學術來源）→ 加第四種「模型服務」
  （搜尋服務），`find-sources` 多一個 `via`；不要塞進 OpenAI 相容 API 那一塊。
- 「研究」（ADR-0033）的規劃對話要邊查邊談：Responses API 的 `web_search` 讓 OpenAI 相容 API 也做得到，
  D5「只有 CLI 能邊查邊談」那一句要改。
