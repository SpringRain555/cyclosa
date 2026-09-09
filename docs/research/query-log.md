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
| 要新增一個**大功能**之前 | 要開始實作 Stage 5–13，等於七個賽道全部相關 |
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
| Obsidian 圖「超過約 500 節點只是變擠」的原始出處 | 那是社群批評的歸納，本質上是 **C 級**。`market-scan.md` 會照 C 級標示，**不會拿它當數字用** —— 我們自己的節點預算是在 Stage 13 用合成資料量出來的 |
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
