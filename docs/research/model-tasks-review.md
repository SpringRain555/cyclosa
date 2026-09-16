# 模型任務的盤點：有哪些、切得動嗎、量過沒有、缺什麼

**日期**：2026-09-16
**狀態**：盤點完成；缺的四個任務進 roadmap 的「規劃中」（不編號）；下一輪的量法寫在最後一節。

---

## 這份文件為什麼存在

使用者 2026-09-16 問了四件事：同一任務能不能正常切換負責模型、任務劃分是否妥當、
連接方式夠不夠模組化、評估是否客觀且有量化依據 —— 並要確認「還缺什麼模型任務」。

`chat-choice.md` 與 `embedding-choice.md` 各是**一次量測**的紀錄；這一份是對整個區域的**盤點**，
回答的是「現在長什麼樣、哪裡是洞」，不是「哪個模型最好」。量測的數字不重抄，指過去。

## 一 · 任務清單與現在對應的模型

任務的唯一定義是 `src/domain/provider/capabilities.ts` 的 `MODEL_TASKS`（四個），主鍵是任務不是角色
（那一段註解寫了為什麼）。設定頁「各任務模型」的表就是它。

> **這台機器上 `%LOCALAPPDATA%\Cyclosa\providers.json` 不存在**（2026-09-16 查證），
> 所以四個任務**一個都沒設定**。下表「建議值」是程式寫死的常數（設定頁一顆「建議」按鈕），
> 不是使用者選過的東西。

| 任務 | 角色 | 需要 | 建議值（常數）| 候選從哪來 | 本機已有的候選（`%AI_MODELS%\INVENTORY.md`）|
|---|---|---|---|---|---|
| `find-sources` 找候選來源 | `agent` | `browse` | 無（空 ＝ CLI 自己的預設）| **文字欄**，CLI 不吐清單 | 只有 `claude -p`；模型名靠打字 |
| `angles` 歸納切入角度 | `chat` | `json_schema`、ctx ≥ 8k | `granite4.2:8b` | Ollama `/api/tags` 或 OpenAI 相容 `/models` 的下拉 | qwen3.5 4b／9b／27b／35b-a3b、granite4.2 3b／8b／30b、gemma4 12b／31b、nemotron-cascade-2:30b、olmo-3 7b-instruct／32b-think、translategemma 4b／12b、qwen2.5:14b-instruct |
| `extract` 抽實體與關係 | `chat` | `json_schema`、ctx ≥ 24k | `qwen3.5:4b` | 同上，可獨立覆寫（`chat.taskModels`）| 同上 |
| `embed` 語意向量 | `embed` | 無（維度是資料庫硬約束）| `qwen3-embedding:4b`；小機器 `0.6b` | 本機 Ollama 的下拉；**刻意不接雲端**（ADR-0009）| qwen3-embedding 0.6b／4b、bge-m3、snowflake-arctic-embed2、granite-embedding:278m、paraphrase-multilingual、nomic-embed-text-v2-moe |

（本機清單的第一欄有五個是 2026-09-16 為下一輪比較拉的，見第六節。）

## 二 · 同一任務能不能正常切換負責模型？

| 任務 | 切換 | 查到的限制 |
|---|---|:--|
| `angles`／`extract` | ✅ 各自一個下拉，空 ＝ 跟著 `chat.model`；`chatFor(task)` 取實際會跑的；閘門檢查的是覆寫後的模型（v0.10.6 修過）；作業紀錄記兩個模型名 | **`baseUrl`／`apiKeyEnv` 不能逐任務分岔**（刻意，`config.ts` 的 `taskModels` 註解）→ 不能「角度跑本機、抽取跑線上」。比較本機模型不受影響 |
| `embed` | ✅ 下拉；換了之後搜尋面板「建立語意索引」按新模型回填，舊模型的向量留著、回報在 `otherModels`（`embed-service.ts`）| 舊向量不清；`vector` 表記 `model+dim`，不符就 `PROVIDER_EMBED_MODEL_MISMATCH`。**沒有「清掉舊模型向量」的按鈕** —— 比較多個嵌入模型會讓資料庫長大 |
| `find-sources` | 🟡 只能打字改 `--model`；沒有清單、沒有「實際打一次」以外的驗證 | **模型名打錯的症狀是子程序回非 0**，畫面說「連不上」。切得動，但不知道切到什麼 |

## 三 · 任務劃分妥當嗎？連接方式夠模組化嗎？

**劃分**：四個任務對三個角色，主鍵是任務。兩個 chat 任務分開的依據是量出來的
（`chat-choice.md` 發現五、六：`nemotron-cascade-2:30b` 角度最好之一、抽取唯一真的捏造引文）。**妥當。**

**模組化，逐角色**：

| 角色 | 接一個新端點要動什麼 | 評 |
|---|---|:--|
| `chat` | 新 `createXxxChat()` ＋ `CHAT_TRANSPORTS` 加一值 ＋ `registry.ts` 的分支。介面 `ChatProvider` 只有 `probe`／`json`／`jsonMode`／`checkJson` | ✅ 兩種傳輸（Ollama 原生、OpenAI 相容）已證明介面夠用；JSON 格式保證逐端點量（ADR-0030）|
| `embed` | 新 `createXxxEmbed()`；`EmbedConfig` 沒有 `transport` | 🟡 刻意只接本機，所以不需要 |
| `agent` | **`AgentConfig` 沒有 `kind`**，`loadProviders` 無條件 `createClaudeAgent` | ❌ 要接第二種 agent（純 API 搜尋、或 OpenAI 相容的 tool-use）得先加 `agent.kind` 與 registry 的分支。介面 `AgentProvider` 本身夠抽象（`run(prompt, cwd, timeout)`）|

**結論**：chat 夠；agent 是單一實作綁死的，**但沒有第二種 agent 之前加 `kind` 是空欄位** ——
到那一天再加，而且那一天要一起想的是「第二種 agent 怎麼被鎖成只能搜尋」（`agent-claude.ts` 檔頭）。

## 四 · 評估客觀嗎？量化標準有依據嗎？

| 任務 | 量過什麼 | 客觀性 | 缺什麼 |
|---|---|:--:|---|
| `embed` | 7 候選、1955 段真實網頁、50 條查詢**先寫死提交再量**、MRR@10、全文檢索當基準線（該贏的贏、該輸的輸）—— `embedding-choice.md` | **強** | 只有一台 RTX 5090；繁中品質沒有人讀過 |
| `extract` | 9 模型、每模型三份不同文件、schema 有效率、**引文命中率**（150 條、用現行 `locateQuote` 重算）、實體／關係／型別數、輸出 token、秒 —— `chat-choice.md` 發現五 | **中** | **沒有正確率**：引文找得到 ≠ 關係是對的。一個模型可以引一句真的話、宣稱一條錯的關係。沒有標準答案集，precision／recall 量不到 |
| `angles` | 六欄機器判；**三個相似度指標都沒量到想量的**（那份文件自己承認）；「混進不相干概念」是人判 n＝3 | **弱** | 沒有標好答案的題目集；建議值 `granite4.2:8b` 的依據是「六條、彼此最不像、seeds 83%」，而 seeds 那一欄自己不可信 |
| `find-sources` | **從來沒量過。** 只有一次真實紀錄（2026-09-08：6 個來源 5 個付費牆）；沒有評測腳本 | **無** | 沒有指標：候選相關性、開放比例、重複率、每條角度的成本 |

### 下一輪要補的量法（以一篇論文為題）

1. **抽取的標準答案集**：對焦點論文（＋ 2–3 份相關文獻）由 agent 先抽、**使用者逐條看過**才算 gold
   （不是 agent 抽的就是對的 —— 否則 gold 只是另一個模型的輸出）。然後每個模型跑
   `tools/research/eval-chat.ts` 同一批文件，算實體與關係的 precision／recall。這是 `extract` 缺的那一欄。
2. **角度的題目集**：對那篇論文的主題，先寫下「合理的切入面向」清單（照 `embedding-eval-queries.jsonl`
   的做法：先提交再量），每個模型的角度逐條標「涵蓋了哪一面向／混進不相干概念」。
3. **找來源的第一個指標**：同一條子問題給 `claude -p` 與 agent 各找一次，比候選數、
   開放比例（用來源清單的紀錄判）、與 gold 文獻的重疊。
4. 三項的判準**先寫進這一區、提交，再跑**（`index.md` 「量測類多守一條規矩」）。

## 五 · 缺的任務

現在沒有、而設計或需求已經指向的：

| 候選任務 | 角色 | 為什麼缺 | 現在是什麼 |
|---|---|---|---|
| **`summarize` 摘要** | `chat` | 翻譯設計說「只翻標題與摘要」（`multilingual.md`），而**沒有任何一步產生摘要**；角度的 seeds 也只用正文前 120 字 | `item.excerpt` ＝ 正文開頭 |
| **`translate` 翻譯** | `chat` | `multilingual.md` 設計完整、閱讀器按鈕已經畫了、是關的 | 無 |
| **`vision` 掃描件與圖片** | `chat`（`vision` 在 `CAPABILITY_FLAGS` 裡）| PDF 沒有文字層「是提示不是失敗」、圖片只登記尺寸 —— 整份沒有正文就抽不到任何關聯 | 無；`vision` 旗標宣告了但沒有任務用它 |
| **`align` 實體對齊建議** | `chat` | `multilingual.md` 寫「LLM 判定 —— 要出處」；現在只有名稱／別名字串比對 | `entity-service.ts` 字串比對 |
| 重排序 `rerank` | —— | ADR-0027 在名次上合併，刻意不加權；**不缺** | —— |

**順序**：`summarize` → `translate`（後者依賴前者）；`vision` 在有掃描件需求時；
`align` 在第一個真實專題累積到夠多實體之後。**先做哪一個等第一個真實專題跑完再定**（使用者 2026-09-16）。

每加一個 chat 任務要動的地方是固定的四處：`MODEL_TASKS` ＋ `CHAT_TASKS`、`config.ts` 的 `taskModels`、
i18n 的 `taskNames`／`taskWhat`／`chatTaskRecommendWhy`、設定頁的表 —— `tests/guards/chat-tasks.test.ts` 守著四份一致。

## 六 · 為下一輪比較拉的模型（2026-09-16）

tag 從 `ollama.com/library/*/tags` 實查，不是憑印象。合計約 50 GB，D: 剩約 1.2 TB。

| 拉 | 大小 | 為了回答什麼 |
|---|---|---|
| `qwen3.5:27b` | 17 GB | **dense 27B 對 MoE 35B-A3B**：抽取保真度來自參數量還是架構？本機 9b 與 35b-a3b 之間沒有資料點 |
| `gemma4:12b` | 7.6 GB | 31b 是關係數最多的（10.5）；12b 是不是同樣的傾向？**全系列支援影像**，也是未來 `vision` 的候選 |
| `granite4.2:30b` | 18 GB | 角度建議值是 8b；角度品質隨大小變嗎？ |
| `olmo-3:7b-instruct` | 4.5 GB | 32b-think 兩種設定都不能用；**instruct 版是另一種模型**，便宜到值得排除掉 |
| `translategemma:4b` | 3.3 GB | 未來 `translate` 的候選；`_meta\models.json` 早就寫著「那一版本機沒有」 |

**不拉** `qwen3.5:122b-a10b`（81 GB）與 `gemma4:26b`（跟 31b 同代 MoE，本機已有 31b）。
`qwen3.5` 系列頁面標 `vision tools thinking`、256K —— 本機的 4b／9b 已經是 `vision` 候選。

登記在 `D:\Projects\_meta\models.json`（`usedBy: []`、`mentionOnly: ["cyclosa"]`、`retain` 寫理由）；
**不寫進 `usedBy`** —— 評測用過不是在用。
