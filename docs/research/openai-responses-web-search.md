# OpenAI 相容端點的 Responses API 與網頁搜尋

**這一份回答 2026-09-19 使用者問的「OpenAI 相容端點不能上網嗎」。** 可信度 **A 級**
（對著使用者那一條端點實測；腳本在當天的 scratch 資料夾，量到的原始回應形狀抄在下面）。
結論寫進 **ADR-0034**。

> **量的是使用者那一條端點**：一個 Codex 訂閱的代理，`/models` 列 5 個 `codex/…` 模型，全部量測用 `codex/gpt-5.5`。
> 位址與金鑰不寫在這裡（金鑰只從環境變數讀，值不進任何一個檔）。**別家端點不一定一樣** ——
> 所以程式裡「會不會搜尋」「有沒有 `/responses`」都是每個端點各自量的，不是抄這一份。

---

## 問題

Cyclosa 到 v0.24.1 對 OpenAI 相容端點只送 Chat Completions，模型碰不到網路。使用者以為那一條端點不支援搜尋
（「好像有支援只是沒試過」）。要回答的是三件事：它有沒有 Responses API、帶搜尋工具會不會**真的**搜、
搜的同時能不能照 json_schema 交出東西（找來源那一步要的正是這個）。

## 量測

| # | 請求 | 結果 |
|---|---|---|
| 1 | `POST /responses`，`tools: [{type:'web_search'}]`，`stream: false`，問「nodejs.org 今天列的最新版是哪一版、引出處」 | HTTP 200，5.1 秒。`tool_usage.web_search.num_requests: 1`，`usage` 都在，**`output: []`** —— 沒有內容 |
| 2 | 同上，`stream: true` | 4.7 秒。事件流：`response.web_search_call.{in_progress,searching,completed}`、`response.output_item.done`（`reasoning`、`web_search_call` 帶 `action.queries`、`message`）、`response.output_text.delta` ×14、`response.completed`。回答一句話帶 nodejs.org 的連結；`response.completed` 裡的 `output` **也是空的** |
| 3 | 串流 ＋ `text.format: {type:'json_schema', strict:true}`（三欄的候選清單）＋ `tool_choice: 'required'` | 9.4 秒，搜了 1 次（3 條查詢），交回符合 schema 的 JSON |
| 4 | **找來源真的會送的東西**：`SOURCES_SYSTEM`、`sourcesUser()`、`strictify(SOURCES_SCHEMA)`，題目是 O-RAN WG11 的規格與白皮書 | 19.4 秒，搜了 2 次（8 條查詢，全是 `site:o-ran.org …`），6 條候選全是 o-ran.org 的官方頁，`why` 是繁中一句話 |
| 5 | `/responses` 不帶工具、`stream: false`、json_schema | 2.9 秒，`status: completed`，**`output: []`**（不串流就是空的，跟工具無關） |
| 6 | 同上，串流 | 2.4 秒，交回符合 schema 的 JSON |
| 7 | 串流 ＋ `temperature: 0` | 收，2.9 秒，結果同上 |
| 8 | 串流 ＋ `text.format: {type:'json_object'}` | 2.1 秒，`{"ok":true}` |
| 9 | 串流 ＋ `max_output_tokens: 40`，要它列 1 到 400 | 17 秒，**整串 400 個數字都回了** —— 上限被忽略，沒有 `response.incomplete` |
| 10 | 串流 ＋ `reasoning: {effort:'low'}` | 1.9 秒，沒有 `reasoning` 項目 |
| 11 | 本機 Ollama `POST /v1/responses`（`qwen3.5:4b`，不串流） | HTTP 200，`object: response`，有內容 |

`usage`：帶搜尋的一次約 6,600–9,500 個輸入 token（其中 1,600–2,700 是快取命中）、80–340 個輸出 token。

## 結論

1. **這一條端點會搜尋**，而且搜尋與 json_schema 同一個請求就做得到 —— 找來源可以走它（ADR-0034 一）。
2. **一律串流。** 不串流回空的 `output`（#1、#5），內容只在串流的 `response.output_item.done` 裡；
   `response.completed` 的 `output` 也是空的，所以讀的是逐個項目的 done 事件（`responses-api.ts`）。
3. **`max_output_tokens` 在這一條端點上不算數**（#9）。程式本來就不送它；截斷偵測靠 `response.incomplete`，
   而在這條端點上那可能永遠不會發生 —— 空回應照樣走「不是 JSON」那條錯誤。
4. `temperature: 0` 收（#7），跟 Chat Completions 那條路一樣送。OpenAI 自家的推理模型會拒收，那是 ADR-0034
   「什麼情況要重新考慮」的第一條。
5. `reasoning.effort` 收（#10）而且更快。這一版不用 —— 抽取的品質量過的是預設值，改了要重量。
6. Responses API 不是這一條端點獨有：本機 Ollama 也有（#11）。所以「先走 Responses API、404 才退回 Chat Completions」
   對別家伺服器多半也成立；真的沒有那條路的，量測會記成 `chat`。

## 沒量的

- **搜尋的品質**：#4 那 6 條看起來都對（官方頁、標題與內容相符），但只有一題。找來源本來就把候選交給擷取管線與
  使用者，不靠這一步保證品質。
- **別家端點**（vLLM、LM Studio、OpenRouter）的 `/responses` 行為 —— 這台機器上沒有。
- **搜尋在對方那邊讀了哪些頁面**：事件流裡只有查詢字串與最後的引用，沒有 `open_page` 的細節。

## 順帶查的：自己接搜尋服務的話有哪些（B 級，2026-09 的比較文）

使用者一度以為要 Cyclosa 自己做搜尋。量到端點會搜之後沒做，但查到的留著（ADR-0034「考慮過、沒有選的」）：

| 服務 | 定位 | 免費額度（2026-09）| 比較文怎麼說 |
|---|---|---|---|
| Tavily | 給 agent 用的搜尋，回結構化結果 | 每月 1,000 credits | agent 用途的評分與 Exa 並列最高 |
| Exa | 語意搜尋 | 每月 10 美元額度 | 語意檢索最強 |
| Brave Search API | 傳統搜尋，快 | 2026-02 起免費層取消，每月 5 美元額度 | 延遲最低 |
| Parallel | 給 agent 的搜尋 | —— | 自稱在 BrowseComp／SimpleQA 上準確度最高、每次最便宜（自家評測）|
| OpenAlex／Semantic Scholar | **學術**搜尋（DOI、引用關係）| 免費、不用金鑰（OpenAlex 2026-02 起有每日額度） | 論文型專題的另一種來源，不是一般搜尋的替代 |

這台機器上這些服務**一把金鑰都沒有**。要接的話是第四種「模型服務」，不塞進 OpenAI 相容 API 那一塊。
