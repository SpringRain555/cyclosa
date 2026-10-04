# 查詢紀錄

**這一份記「查過什麼、何時、查到什麼、可信度幾級」。** 結論在 `market-scan.md`，
規則（可信度分級、重查門檻、擷取紀律）在 `index.md`。

> ## 這份文件從 2026-09-06 才開始存在
>
> 2026-09-04 那次調查**沒有留紀錄，而且刻意不事後補**（理由見 `index.md`）。
> 這一份是 **2026-09-06 重跑**時從第一個查詢就開始記的。
>
> **兩次調查的紀錄狀態不同，所以結論的可信度也不同** ——
> `market-scan.md` 裡標「2026-09-06」的條目可以逐條回溯到下面的某一列與
> `sources/manifest.jsonl` 的某一個雜湊；標「2026-09-04」的不行。

---

## 重查的觸發條件

`index.md` 的重查門檻列了四種情況，這次同時命中三種：

| 條件 | 命中情形 |
|---|---|
| 要新增一個**大功能**之前 | 要開始實作 v0.1.0–v0.12.0，等於七個賽道全部相關 |
| 要加一個**新依賴**之前 | 要加 24 個套件，每一個都要查授權 |
| 距上次調查超過半年 | **沒有命中**（上次是 2026-09-04，只隔兩天） |

第三條沒命中而仍然重跑，理由是前兩條 —— 以及 2026-09-04 那次**沒有留紀錄**，
所以它的結論本來就處在「有人查過但沒辦法逐條回溯」的狀態。

## 日期用的是 UTC，而本機是 UTC+8

**這一輪的抓取發生在 UTC `2026-09-06T16:55`–`17:14`，換算本機時間是 `2026-09-07` 凌晨。**

`sources/manifest.jsonl` 的 `fetched_at` 是 **UTC ISO-8601**（那是機器欄位，
不該帶時區偏移），而**這份文件與各 ADR 的日期標的也是 UTC** —— 兩邊才對得起來。

> **寫下來是因為它看起來像對不上。** 有人在本機把時戳一轉，得到 `09-07`，
> 然後對照文件上的 `09-06` —— **那不是筆誤，是時區。**
> 一個跨午夜的日期差，如果沒有人說清楚用的是哪個時區，
> 之後每一次對照都要重新推一遍。

## 方法與紀律

- **`sources/manifest.jsonl`**：55 列，每列記 URL、抓取時間、HTTP 狀態、content-type、
  SHA-256、位元組數。**52 列有雜湊**；沒有雜湊的 3 列**明寫了原因**
  （`sha256_absent_because` 欄）—— 那三個網頁是經過 markdown 轉換取得的，沒有可雜湊的原始位元組。
- **同網域請求間隔 ≥ 300–400 ms 之外另有一層保護**：這次的來源集中在
  `api.github.com`（帶 token，額度 5000/hr）與 `registry.npmjs.org`，兩者都是為程式化存取設計的 API，
  不是要保護的內容網站。**沒有對任何內容網站做批次抓取。**
- **AGPL-3.0 的四個專案只取 README**（說明文件），**沒有取任何原始碼檔案** —— ADR-0011 的紅線。

---

## 2026-09-06　依賴授權實查（A 級）

**查什麼**：24 個規劃中的 npm 套件，取 `https://registry.npmjs.org/<pkg>/latest` 的 `license` 欄。
**為什麼是 A 級**：那是套件發佈時自己宣告的授權欄位，不是第三方轉述。

**結果**：24 個全部通過，**沒有一個是 AGPL**。

| 授權 | 套件 |
|---|---|
| MIT（19） | `fastify` 5.12.3、`vue` 3.5.42、`vue-router` 5.3.1、`pinia` 4.0.3、`three` 0.185.1、`3d-force-graph` 1.80.0、`d3-force-3d` 3.0.6、`franc` 6.2.0、`vite` 8.2.2、`vitest` 5.0.0、`vue-tsc` 3.3.11、`eslint` 10.10.0、`typescript-eslint` 8.69.0、`eslint-plugin-vue` 10.11.0、`eslint-config-prettier` 10.1.8、`prettier` 3.9.6、`tsx` 4.23.13、`@vitejs/plugin-vue` 6.0.8、`globals` 17.12.0、`@types/node` 26.4.1 |
| Apache-2.0（3） | `@mozilla/readability` 0.6.0、`pdfjs-dist` 6.3.289、`typescript` 7.0.2 |
| ISC（1） | `linkedom` 0.18.13 |

**新知道的三件**：

1. **`linkedom` 是 ISC** —— `versions.md` 之前沒寫過它的授權。ISC 是寬鬆授權，可用。
2. **`pdfjs-dist` 是 Apache-2.0** —— 使用者這一輪決定第一版要做 PDF，這條是那個決定的前提，現在確認了。
3. **`typescript` 的 latest 已經是 7.0.2**（Apache-2.0）—— 但見下面那條，不能用。

## 2026-09-06　工具鏈版本相容性（A 級）

**查什麼**：`typescript-eslint`、`vue-tsc`、`vitest`、`vite` 的 `peerDependencies` 與 `engines`。
**為什麼查**：`versions.md` 列了「三組要一起升」，但沒有記下**界線是誰訂的**。

**兩個結果推翻了 `versions.md` 現有的內容**：

| 查到的事實 | 對 `versions.md` 的影響 |
|---|---|
| **`typescript-eslint` 8.69.0（最新）的 peer 仍是 `typescript >=4.8.4 <6.1.0`** —— 往回查 8.64～8.68 全部一樣 | `versions.md` 寫 `typescript ^6`，而 `^6` 允許 6.1，**會踩出 peer 衝突**。要改成 `~6.0`。TypeScript 7 更是完全不能用 |
| **`vite` 8.2.2 的 `engines.node` 是 `^20.19.0 \|\| >=22.12.0`** | `versions.md` 寫「Node 下界 24 的第二個理由是 **Vite 8 要 Node 24**」—— **這句話是錯的**。真正的理由只剩 `node:sqlite` 一條 |
| `vitest` 5.0.0 的 `engines.node` 是 `^22.12.0 \|\| ^24.0.0 \|\| >=26.0.0` | Node 24 通過 |
| `3d-force-graph` 1.80.0 **依賴**（不是 peer）`three >=0.179 <1`，而 `three` 實際已到 0.185.1 | `versions.md` 寫 `three ^0.17x`，**過期**。改成跟著 `3d-force-graph` 的範圍走 |

> **`vite` 那一條值得單獨記。** 一條寫著「有兩個獨立理由、任一個都足夠」的版本下界，
> 其中一個理由是假的 —— 而它看起來比另一個更具體，所以更容易被當成真的。
> 下界 24 仍然成立，但**它現在只有一條腿**，放寬時要知道這件事。

## 2026-09-06　對手專案授權與存活狀態（A 級）

**查什麼**：19 個 repo 的 `license.spdx_id`、`pushed_at`、`archived`。

**三條更正 2026-09-04 那份授權盤點的內容**：

1. **Zotero 查不到 AGPL。** GitHub API 回 **`NOASSERTION`**（分類器因為商標條款與第三方著作權註記
   無法歸類）。**直接讀 `COPYING` 才看得到**：
   > The Corporation for Digital Scholarship distributes the Zotero source code
   > under the GNU Affero General Public License, version 3 (AGPLv3).

   **結論不變（Zotero 確實是 AGPL-3.0），但方法要改。**
   2026-09-04 那份寫著「GitHub API 實查」並列出 AGPL-3.0 ——
   **用它宣稱的方法問不出那個答案。** 那條結論是對的，但它的來源標示是錯的。
2. **Linkwarden 是 AGPL-3.0，而它不在紅線名單上。** 它出現在 `market-scan.md` 的
   「保存／稍後讀」那一列，卻沒有進授權盤點表。**現在補進紅線。**
3. **`cosmos.gl` 的 repo 路徑是 `cosmosgl/graph`**（MIT，1.2k star，2026-09-05 還有 push）。
   `cosmograph-org/cosmos` 會轉址過去，直接打 API 會 404。

**還查到一件 2026-09-04 沒寫的事**：

4. **Aleph 正在日落。** README 首段是 `PROJECT STATUS: SUNSETTING`：
   OCCRP 把資源全部轉去專有的 **Aleph Pro**，開源版**維護到 2025-12-31 為止**，
   之後不再有更新、修補或支援。
   `market-scan.md` 把 Aleph 列為活躍對手兼「MIT，概念與程式碼都可借」——
   **那個判讀現在只剩一半成立**：程式碼還在、授權還是 MIT，但它是一份不再維護的程式碼。
   **真正還活著的可借部分是 `alephdata/followthemoney`**（MIT、2026-02-28 還有 push、未封存）。

| 授權 | 專案（`pushed_at`） |
|---|---|
| MIT | Aleph（2026-02-20，**日落**）、followthemoney（2026-02-28）、ArchiveBox（2026-09-04）、GraphRAG（2026-09-02）、LightRAG（2026-09-06）、STORM（**2025-09-30，將近一年沒動**）、3d-force-graph（2026-04-05）、d3-force-3d（2025-04-09）、sigma.js（2026-08-20）、cosmos.gl（2026-09-05） |
| Apache-2.0 | readability（2026-08-04）、trafilatura、cognee（2026-09-06）、Graphiti（2026-09-06）、GPT-Researcher（2026-08-27） |
| **AGPL-3.0 · 只讀概念** | **Datashare**（2026-09-05）、**SingleFile**（2026-09-06）、**Karakeep**（2026-08-31）、**Linkwarden**（2026-09-05）、**Zotero**（2026-09-04，要讀 `COPYING`） |

## 2026-09-06　七個賽道的設計研究（A 級：各專案自己的 README）

18 份 README，逐份看**它們怎麼解同一個問題**（不是只看缺什麼）。
結論寫進 `market-scan.md`，這裡只記查了什麼。

| 賽道 | 取了誰的 README | 想回答的問題 |
|---|---|---|
| 調查／OSINT | Aleph、Datashare | 實體型別與出處模型怎麼設計 |
| LLM 圖譜函式庫 | GraphRAG、LightRAG、cognee、Graphiti | 抽取出來的關係怎麼存出處、怎麼處理「事實會變」 |
| 深度研究代理 | STORM、GPT-Researcher | 多視角提問實際上是怎麼產生的 |
| 保存／稍後讀 | ArchiveBox、SingleFile、Karakeep、Linkwarden | 快照存什麼格式、能不能離開工具讀 |
| 圖渲染 | 3d-force-graph、cosmos.gl、sigma.js | 我們要包的那一層底下是什麼 |
| 抽取 | readability、trafilatura | 正文抽取的介面與失敗模式 |
| 標註 | Hypothesis | W3C 選擇器的實際用法 |

**額外查的一份**：`alephdata/followthemoney/followthemoney/schema` 的目錄列表 ——
**70 個 schema**，其中有 `Mention.yaml` 與 `Similar.yaml`。

## 2026-09-06　NotebookLM 的現況（A 級：官方說明文件）

**為什麼查**：`market-scan.md` 說它「綁單一模型、來源數上限、無圖、無本機保存」，
而「來源數上限」是一個會隨時間變的數字。

| 查到的 | 來源 |
|---|---|
| **已更名為 Gemini Notebook**（2026-09-02 起改用彈性用量上限） | `blog.google/.../new-flexible-usage-limits/` |
| 免費：100 個筆記本 × **每個 50 個來源** | `support.google.com/notebooklm/answer/16213268` |
| Pro：500 個筆記本 × **每個 300 個來源** | 同上 |
| 每個來源上限 **50 萬字或 200 MB** | `support.google.com/notebooklm/answer/16269187` |
| 說明文件裡**沒有任何圖／關聯視覺化功能** | `.../answer/16269187` |

**「無圖」這條到今天仍然成立**，而且是從官方說明文件確認的，不是憑印象。

---

## 這次沒有查、以及為什麼

**沒有查的東西要寫下來**，否則下一個人會以為整份調查是完整的。

| 沒查 | 為什麼 |
|---|---|
| Obsidian 圖「超過約 500 節點只是變擠」的原始出處 | 那是社群批評的歸納，本質上是 **C 級**。`market-scan.md` 會照 C 級標示，**不會拿它當數字用** —— 我們自己的節點預算是在 v0.12.0 用合成資料量出來的 |
| Maltego、i2、Linkurious | 商業授權、沒有公開 repo 可實查。它們在賽道表裡的角色是「這個賽道有商業解」，不是可借的設計 |
| Heptabase、Scrintal、TheBrain、Connected Papers、ResearchRabbit、Litmaps 的當前功能 | 都是閉源產品，要逐一註冊試用才問得出來。**它們的判讀維持 2026-09-04 的狀態並標明**，不假裝重查過 |
| 2026 WCXB 正文抽取評測的原始數據 | `market-scan.md` 引了 F1 數字（`rs-trafilatura` 0.910 等）。這次**沒有回到原始評測**，所以那幾個數字仍然是 **B 級**、標著 2026-09-04 |

## 2026-09-09　嵌入模型候選（A 級）

**查什麼**：七個多語言嵌入模型的**授權、最後更新時間、下載數**（Hugging Face 的
model API，模型自己宣告的欄位）、**Ollama 上的下載大小**（registry 的 manifest，
把各層的 `size` 加起來）、以及**維度與上下文長度**（各模型的 `config.json`）。

**為什麼查**：`bge-m3` 是照計畫書帶進來的，**從來沒有跟任何候選比過** ——
而它是這個專案裡唯一實質不可逆的決定（換模型要重算全部向量，
而且比對不會報錯，只會安靜地變爛）。結論在 `embedding-choice.md`。

**紀律**：三個來源都是**為程式化存取設計的 API**
（`huggingface.co/api`、`registry.ollama.ai/v2`），跟前幾輪的
`api.github.com`／`registry.npmjs.org` 同一類。**同網域請求間隔 4 秒**，
19 列全部進 `sources/manifest.jsonl`（URL、時間、狀態、content-type、SHA-256、位元組）。

**兩個結果直接刷掉了候選**：

1. **`jina-embeddings-v3` 的授權是 `cc-by-nc-4.0`** —— 非商業。
   這是模型自己宣告的欄位，不是推測，而這個 repo 預計要公開。**出局。**
2. **`google/embeddinggemma-300m` 的 `config.json` 回 401** ——
   要登入同意 Gemma 條款才拿得到。授權本身也是自訂條款而不是 OSI 授權。
   **一個要先登入的模型，跟「使用者自己 `ollama pull`」是兩件事。**

**一個關於來源級別的觀察**：只有 `Snowflake/snowflake-arctic-embed-l-v2.0` 在
**機器可讀的欄位**裡宣告了語言清單（74 種）。`bge-m3` 與 `qwen3-embedding` 的
「100+ 語言」是 README 的散文 —— 一樣是第一手，但**查證方式不同，級別也就不同**。

**還查到一件會改變預設的事**：`bge-m3` 的最後更新是 **2024-07-03**，
而 `Qwen/Qwen3-Embedding-0.6B` 是 **2026-04-20**；後者的 Ollama 下載只有
610 MB（前者 1104 MB）、上下文 32768（前者 8194），維度同樣是 1024。
**`bge-m3` 唯一明顯領先的是下載數（38.0 M 對 7.5 M）** —— 而那是生態，不是檢索品質。

> **這一輪沒有量任何檢索品質。** 上面每一條都是「查得到的欄位」，
> 而「哪一個找得比較準」要一組評測集才答得出來，設計寫在 `embedding-choice.md`。
> **把下載數當成品質的代理指標，就是在用「多少人用過」回答「準不準」。**

## 2026-09-09（下午）　嵌入模型實測

**查什麼**：上午那一輪只查了「查得到的欄位」，這一輪補上**檢索品質** ——
七個候選、同一批語料、同一組查詢、同一支比對程式。

**新增的 A 級查證**（`sources/manifest.jsonl`，同網域 4 秒）：

| 查了什麼 | 結果 |
|---|---|
| `Alibaba-NLP/gte-multilingual-base` 有沒有 GGUF | **沒有**（HF 全站搜尋只有它的 reranker 版本有）→ Ollama 拉不到 → 出局 |
| `nomic-ai/nomic-embed-text-v2-moe-GGUF` 是誰發的 | **模型作者自己**（`nomic-ai` 組織），不是第三方轉檔 → A 級，可測 |
| 六個模型 card 上的**前綴** | `qwen3` 要 `Instruct:…\nQuery:`、`arctic-embed` 要 `query: `、`nomic-v2` 要 `search_query:`／`search_document:`；`bge-m3`、`granite`、`paraphrase` 沒有 |
| Ollama 的 `paraphrase-multilingual` 到底是哪一個 | **mpnet-base-v2 不是 MiniLM** —— 靠 `ollama show` 的參數量（277.45M）與 `num_ctx 128` 對出來的 |
| `intfloat/multilingual-e5-*` | MIT、下載數高，但官方 repo **沒有 GGUF**，只有第三方轉檔（B 級）→ 不列入 |

**兩件推翻自己前一版說法的事**：

1. 上午寫「**只有** Snowflake 在機器可讀欄位裡宣告語言清單」——
   那是只查了六個 repo 的結論。查到第七個（`paraphrase-multilingual-mpnet-base-v2`，
   50 種語言）就不成立了。**「只有一個」這種話要查完才能說。**
2. `nomic-embed-text-v2-moe` 的 model card 用粗體寫著前綴 **must** 加，
   而實測**加了反而更差**（MRR 0.620 → 0.579）。照 model card 做也可能是錯的。

**自己的守門擋住自己**：第一版語料走 Wikipedia 的 `action=query` API，
34 個請求全部回 `FETCH_ROBOTS_DISALLOWED`。查 `robots.txt` 確認
`User-agent: *` 底下有 `Disallow: /w/` 與 `Disallow: /api/`。
**改的是路徑（`/wiki/` 與 `/zh-tw/`，都在放行範圍內），不是改檢查。**

**結論**：`bge-m3` 與它的主要挑戰者 `qwen3-embedding:0.6b` **打平**
（逐條配對 10:9，MRR 0.793 對 0.790）；兩者都輸給同家族的
`qwen3-embedding:4b`（對 `bge-m3` 15:1，跨語言 MRR 0.940 對 0.685）。
完整設計與數字在 `embedding-choice.md`。

> **這一輪量的是檢索品質，不是「哪個比較有名」。** 上午那一輪的下載數
> （`bge-m3` 38.0 M 對 `qwen3-embedding:0.6b` 7.5 M）在配對比較裡完全沒有預測力 ——
> 那兩個模型打成硬幣。**把下載數當品質的代理指標，就是在用「多少人用過」回答「準不準」。**

## 2026-09-09（傍晚）　`chat` 角色實測

**查什麼**：不是查資料，是**跑量測**。四個本機模型、兩個任務、各三次，
指標全部機器判（schema 有效率、引文命中率、角度相似度、`seeds` 有效率）。
完整設計與數字在 `chat-choice.md`。

**為什麼查**：`capabilitiesOf` 對每一個 Ollama 模型都無條件宣告
`json_schema: true`，而 ADR-0006 的閘門就是靠它決定要不要停手。
那個宣告從來沒有被驗證過。

**紀律**：這一輪**沒有任何網路請求** —— 語料是 2026-09-09 上午抓的那一批
（頁面清單與版本編號在 `fetch-eval-corpus.ts` 與 `sources/manifest.jsonl`），
模型全部在本機。所以 `sources/manifest.jsonl` 這一輪沒有新增列。

**結論**：`json_schema: true` 對其中兩個是錯的 ——
`nemotron-cascade-2:30b` 抽取六次全部回 0 個字元，
`olmo-3:32b-think` 從來沒有在出貨的 180 秒逾時內完成過。
**四個都不夠好，所以這一輪不訂預設值。**

**一件推翻自己設計的事**：我把引文命中率列成最重要的一欄，
量完之後它是 49/50 —— **那個風險沒有發生**。真正的失敗模式是根本沒有輸出。
如果只量了那一欄，四個模型會全部拿到漂亮分數，
**然後我們會選一個六次裡有四次交不出東西的模型。**

## 2026-09-11　範例專案的語料授權

**查什麼**：v0.17.0「範例專案」要放進 repo 的語料，能不能合法重製與再散布。
四個查詢：著作權法 §9 的條文原文、全國法規資料庫的資料開放宣告、
政府資料開放平臺上的法規資料集、以及 `law.moj.gov.tw` 的 `robots.txt`。

**為什麼查**：計畫書把這一步排在寫任何一行程式之前，
規矩是**查不到明確授權就不用那份語料**。
完整結論在 `sample-corpus-licence.md`。

**級別**：三份是一手（法規原文、網站自己的宣告頁、資料集頁），
`robots.txt` 是直接讀原檔。沒有依賴任何二手解讀。

**結論**：兩個獨立的依據都成立 —— 著作權法 §9（條文原文**不是**著作權標的）
與政府資料開放授權條款第 1 版（無償、可再授權、**不會嗣後撤回**、須註明出處）。

**一件把方向掉過來的事**：`law.moj.gov.tw/robots.txt` 是 `Disallow: /`，
**整個站不准爬**。而 Cyclosa 自己就有一個會讀 robots.txt 並照做的爬蟲 ——
用爬來的語料當它的範例專案，方向剛好是反的。
所以改走 data.gov.tw 上公告的官方大量下載端點（`sendlaw.moj.gov.tw`，
該站沒有宣告 robots 限制）。

> **順序的教訓**：先問「這個站有沒有給一條正式的路」，沒有再問能不能爬。
> 反過來就會先看到一份抓得動的 HTML，然後才想起要去看 robots。

## 2026-09-11（晚）　OpenAI 相容端點的 JSON 格式支援（A 級）

**為什麼查**：v0.18.0 的第一條收尾條件 —— 動手前先量目標端點的 `json_schema` 支援程度。

**先查了能不能量線上端點**：這台機器上的環境變數**沒有任何線上服務的金鑰**
（只看名字，不讀值）。所以線上端點一個都沒有量；量的是本機唯一的 OpenAI 相容端點。

| 查詢 | 對象 | 結果 |
|---|---|---|
| `GET /api/version` | 本機 Ollama | 0.33.2 |
| `GET /v1/models` | 本機 Ollama | 列得出來 —— **而且嵌入模型也在裡面，沒有任何能力欄位** |
| `json_schema` 探針 × 3 | `qwen3.5:4b`、`granite4.2:8b` | 3/3 符合；對照組 0/3 是 JSON |
| `json_object` × 3 | 同上 | 3/3 是物件 |
| 原生 `think:false`／`think:true`／`/v1` × 3 | `qwen3.5:4b` | 0.45 秒／4.1 秒／4.1 秒；`/v1` 的思考字數與 `think:true` 完全相同（2,935）|
| `checkJson`（出貨的程式）× 3 | `qwen3.5:4b`、`granite4.2:8b`、`qwen3-embedding:4b` | `schema`／`schema`／**`none`**（"does not support chat"）|

**級別**：全部是對著真的端點實測，腳本在 `tools/research/probe-json-mode.ts`。

**結論**：`chat-ollama.ts` 檔頭那句「OpenAI 相容那條路只到 `json_object`」**在 Ollama 0.33.2 上不成立**。
本機 Ollama 仍然走原生協定，理由換成「`/v1` 送不了 `think: false`，慢 9 倍」。
完整寫在 `openai-compat-json-schema.md`。

> **一句沒有日期的量測結果，會在對方升版之後變成假話。** 那句話寫的時候是對的。

## 2026-09-16／09-17（UTC）　資安來源與候選模型（A／B 級；**沒有保存原始回應**）

**為什麼查**：v0.20.0 把使用者給的資安清單放進內建來源（`security-sources.md`），
並為下一輪的模型比較拉五個模型（`model-tasks-review.md` §6）。
09-17 那一批（本機是 09-18 凌晨）是回答「這一輪還剩什麼」之前的重新核對 —— **它推翻了 09-16 的一條**。

| 查詢 | 日期（UTC）| 結果 | 級別 |
|---|---|---|---|
| ISC SANS `/api/infocon?json` | 09-16、09-17 | 200；09-17 看了內容：JSON | A |
| NVD `/rest/json/cves/2.0?resultsPerPage=1` | 09-16、09-17 | 200；09-17 看了內容：JSON | A |
| dblp `/search/publ/api?q=security&format=json&h=1` | 09-16、09-17 | 200、`text/html`；**09-17 才看內容：反爬蟲驗證頁**（09-16 只看了狀態碼，卻寫了「內容是 JSON」）| A |
| WebFetch `dblp.org/db/conf/{acsac,raid}/` | 09-17 | 同一種驗證頁（Anubis）| A |
| `https://cve.mitre.org/` | 09-16 | 301 → `www.cve.org/Resources/Media/Archives/OldWebsite/index.html` | A |
| `scholar.google.com/robots.txt` | 09-16 | `Disallow: /scholar`、`Disallow: /search` | A |
| `ollama.com/library/{qwen3.5,gemma4,granite4.2,translategemma,olmo-3}/tags` | 09-16 | 各 tag 與大小（WebFetch 的摘要）；五個 `ollama pull` 都成功 | B（清單）／A（拉得到）|
| HF `api/models/…` 的 license 欄（五個候選模型）| 09-16 | 四個 `apache-2.0`；`translategemma-4b-it` 是 `gemma`（gated: manual）| A |
| NVD 的限流（搜尋；說明頁是 JS 殼，原始 HTML 2,453 位元組、沒有數字）| 09-17 | 沒帶金鑰的請求在 30 秒滾動視窗內的額度較小；**數字取不到** | B |
| `acsac.org/2024/proceedings/` | 09-17 | 302 → `doi.org/10.1109/ACSAC63791.2024`（IEEE 的 DOI 前綴）| A |
| RAID 論文集（搜尋）| 09-17 | 24、25、27 屆在 ACM DL（DOI 前綴 `10.1145`）| B |
| ACM 開放取用（搜尋；`acm.org`、`dl.acm.org` 對 WebFetch 回 403）| 09-17 | 2026-01-01 起全部出版品開放取用（ACM 公告標題 ＋ 另一篇報導）| B |

**沒有做到的**：這些都是一次性的 `Invoke-WebRequest`／WebFetch／搜尋，**沒有保存原始回應、沒有進 `sources/manifest.jsonl`**
—— 可以重跑，不能逐位元組回溯。這一節記下查了什麼，好讓重跑的人知道要比對哪些數字。

> **09-16 的 dblp 那一列是這一段裡唯一的錯誤結論，而它錯的方式這個專案記過**：
> 出版社首頁一律回 200、文章回 403，所以出版社不設探針（v0.7.0，`catalog.ts` 檔頭）。
> 加新探針的時候讀過那段話，**照樣只看了狀態碼**。教訓在 `lessons.md`，「驗證頁怎麼認」是 `open-questions.md` Q7。


## 2026-09-18（UTC）　反爬蟲驗證頁怎麼認（A／B 級；**沒有保存原始回應**）

**為什麼查**：使用者說「這題我想不到解法，去參考別人的做法」。結論寫進
`domain/ingest/challenge.ts` 與 `fetch-policy.md`，Q7 因此結案。

| 查詢 | 結果 | 級別 |
|---|---|---|
| Cloudflare 官方〈Detect a Challenge Page response〉| 任何類型的挑戰頁都帶 `cf-mitigated: challenge`，而 `challenge` 是這個標頭**唯一**的合法值；挑戰頁的 content-type **一律 `text/html`**，不管原本要的是什麼 | A（官方文件原文）|
| Anubis 的 Challenges 文件 | 挑戰頁內含挑戰參數 JSON ＋ 算 nonce 的 JavaScript；另有不需 JS 的 metarefresh 型 | B（文件沒有明寫狀態碼與標頭）|
| `curl dblp.org/search/publ/api?...`（**這一次不該打，見下**）| 200、`text/html`、7,489 B、`cache-control: no-store`；`<title>Making sure you're not a bot!</title>`、`<meta name="robots" content="noindex,nofollow">`、`<script id="anubis_version">`、樣式表在 `/.within.website/x/xess/`；cookie 名是**從網域算出來的**（`dblp_org-auth-…`）—— 一份「知名反爬蟲 cookie 名稱」清單抓不到它 | A（實際回應）|
| `curl dblp.org/robots.txt` | `User-agent: *` ＋ `Disallow: /`（4,125 B，前面列了上百個 AI bot 的 UA，最後兩段都是整站禁止）| A |
| **走 `Crawler` 實跑 dblp 的探針** | `FETCH_ROBOTS_DISALLOWED`（`rule: Disallow: /`、`source: fetched`）—— **請求根本沒送出去** | A（走的是產品自己的路）|
| wafw00f 的做法（搜尋）| 先看標頭／cookie／封鎖頁特徵比對簽章庫，不夠再送探測請求；**順序是標頭 → cookie → 內文** | B |
| Zyte／Scrapy 生態的 soft block（搜尋）| 200 ＋ 驗證頁 ＝ 軟封鎖，跟成功的回應長得一樣；預設「非 200 就是壞」的啟發式抓不到，所以 ban detection 要是可替換的判斷點 | B |

**兩件要記住的**：

1. **`curl` 那兩列是在終端機裡直接打的，沒有先問 robots** —— 而工具自己不會那樣做。
   教訓在 `lessons.md`（「工具守著 robots，而我在終端機裡直接打了那個網址」）。
   之後要看外部網站回什麼，走 `Crawler`；真的要用 `curl`，**先抓 robots.txt**。
2. Cloudflare 那一列是**唯一有官方文件背書**的標記，其餘都是觀察或二手整理 ——
   所以判斷的第一層刻意**不依賴任何產品知識**（要的型別與拿到的型別矛盾），
   第二層才是這份會過期的清單。

## 2026-09-18（UTC，第二輪）　第一個線上 chat 端點（A 級）

**為什麼查**：使用者提供一把第三方代理（kano-proxy，非官方 OpenAI）的金鑰，
要求測試。這是這台機器上**第一次**有線上 OpenAI 相容端點可以量
（v0.18.0 的第一條收尾條件從 🟡 變成有答案）。

| 查詢 | 結果 | 級別 |
|---|---|---|
| 第三方代理的 `/robots.txt`（網域不列） | `Disallow: /openai/ /anthropic/ /g/ /api/ /agent/`，文件路徑允許 | A |
| 代理的 getting-started 文件 | OpenAI 相容的位址是 `https://<網域>/openai/v1`，`Authorization: Bearer`；另有 Anthropic 相容的 `/anthropic/v1` 用 `x-api-key` | A |
| `GET /openai/v1/models` | 200，5 個模型（`codex/gpt-5.5`、`codex/gpt-5.6-{luna,sol,terra}`、`codex/gpt-6-astra`），與使用者畫面一致 | A |
| `checkJson`（探針 schema） | `schema` —— `json_schema` 真的被套用 | A |
| 「實際打一次」（修正前） | **失敗** `PROVIDER_JSON_UNSUPPORTED` | A |
| 直接送兩種 schema 比對 | 沒有 `additionalProperties: false` → HTTP 400 `invalid_json_schema`；有 → 200 | A |
| 三份真的 schema（strictify 之後） | 角度／抽取／找來源都 **HTTP 200** | A |
| 「實際打一次」（修正後） | **通過**，5.1 秒；`provider-checks.json` 記下 `schema` | A |

**先前的那一把金鑰（同一個變數）** 打 `api.openai.com` 回 401 `invalid_api_key`，
而 OpenAI 自己遮過的訊息顯示它是 `sk-kano-` 開頭 —— **不是 OpenAI 的金鑰**。
**沒有拿它去試任何沒被指名的端點。**

**沒有做到的**：只量了 5 個模型裡的 1 個（`codex/gpt-5.5`）；
端點不回報 context 長度與金額，所以那兩欄在畫面上分別是「不知道」與 `null`。

## 2026-09-28（UTC）　重查：對外宣稱差異之前（A／C 級）

**為什麼查**：對外的文件會寫 Cyclosa「跟現有產品差在哪」。
那些句子會被讀者拿去對照，所以在寫之前把 09-06 的判讀逐條重查 —— 另外 Stage 21–24 是大功能，
本來就在 `index.md` 的門檻內。結論寫在 `market-scan.md` 的〈2026-09-28 重查〉。

**拆題**：不是照產品類別查，是**照 Cyclosa 的功能模組**查「誰解過、怎麼解、授權、借什麼、差在哪」
（規劃、蒐集與候選、擷取保存、閱讀點註、抽取建圖、人工裁決、可信度、圖瀏覽、檢索、匯出、多語、本機與模型），
另外一題是「有沒有端到端的同類」。**飽和判準**：一個類別連續三個新項目都沒有帶來新的設計樣式就停。

**紀律**：搜尋結果只當線索（C），每一條要寫進結論的都回到產品自己的頁面或 README（A）；
原始回應存在 agent 沙箱（不進 repo），**雜湊進 `sources/manifest.jsonl`（40 列，全部有 SHA-256）**；
同網域間隔 4 秒、每網域 ≤ 8 個請求，**GitHub 那一批超過上限，事先徵得使用者同意**；AGPL 專案只讀 README。
抓取時間 UTC 14:18–14:26（本機 22:18–22:26）。

| 批次 | 檢索詞／目標 | 擷取方式 | 結果 | 失敗或限制 |
|---|---|---|---|---|
| W1–W12 | NotebookLM 心智圖、Neo4j Graph Builder、InfraNodus、Co-STORM、Gemini Deep Research 編輯規劃、開源 NotebookLM 替代品、LightRAG WebUI、人機協作知識圖譜、Recall、Memorwise、GRACE、Heptabase | WebSearch | 找出新候選：Memorwise、Open Notebook、SurfSense、Kotaemon、GRACE、CleanGraph | 搜尋摘要只當線索（C）；結論一律回到下面 A1／G1 |
| W13–W20 | Maltego AI、System、Hunchly、MindSearch、Kotaemon、台灣事實查核與資訊操弄、Obsidian 外掛、文獻圖譜、INCEpTION、CleanGraph、Elicit／Undermind、資策會標記工具、Heptabase 創辦團隊 | WebSearch | 補齊調查、證據圖、人機協作、在地四個類別 | Heptabase 的台灣背景、Cofacts.ai、Taiwan AI Labs、資策會工具只有 C 級 |
| A1 | 15 個產品自己的頁面（Gemini Notebook 與 Deep Research 說明、Neo4j Labs、InfraNodus、Recall 文件、Memorwise、Heptabase changelog、Maltego、Hunchly、System、arXiv 2609.04442 與 2405.03932、INCEpTION、Cofacts.ai、Undermind）| `bulk-fetch`（robots 依 RFC 9309、同網域 4 秒）＋ trafilatura 抽正文 | 15／15 回 200；NotebookLM 說明頁轉址到 `support.google.com/gemininotebook/…`（manifest 記了 `final_url`）| **cofacts.ai 是 JS 殼**（抽出 138 字），沒有用；Undermind 頁上的比較數字是廠商自己的評測，不引用 |
| G1 | 12 個 repo 的 `repos/{o}/{r}` ＋ README；SurfSense 另讀 `license` | `gh api`（已登入，間隔 1 秒）| 授權、建立與最後 push 時間、星數、README 全部拿到 | **超過每網域 8 個請求**，使用者同意後才跑；SurfSense 的 API 授權是 `NOASSERTION`，讀 `LICENSE` 才知道是混合授權（BSL 1.1 ＋ Apache-2.0）|
| L1 | 本 repo `node_modules` 每個套件的 `package.json` `license` 欄 | 本機腳本，沒有網路 | 321 個套件，GPL 系 0 | 只看套件自己宣告的欄位，沒有逐一開 `LICENSE` 檔 |

**三件要記住的**：

1. **「比 GRACE 早」差點寫進去。** 寫模組對照時的第一個直覺是 Cyclosa 的二部圖設計早於 GRACE ——
   對了兩邊的日期才發現相反：GRACE 2026-09-03 上 arXiv，ADR-0005 是 2026-09-06 的 commit。
   **時間先後的宣稱要對兩個日期，不要對印象。**
2. **09-06 的「AI 研究助理無圖」查的頁是對的、範圍不夠。** 那次讀的說明頁確實沒提圖，
   而心智圖寫在另一頁。**「說明文件裡沒有」只能推到「那一頁沒有」。**
3. **GitHub API 的 `NOASSERTION` 第二次不代表沒有授權** —— Zotero 是商標條款讓分類器放棄，
   SurfSense 是一個 repo 裡兩種授權。兩次都要讀 `LICENSE` 才知道答案。
