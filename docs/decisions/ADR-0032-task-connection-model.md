# ADR-0032 模型設定以任務為主鍵：每個任務挑一條連線、一個模型

- 狀態：**已採納**（2026-09-19，v0.24.0）
- 依據：2026-09-18 使用者第一次真的用這個工具，回報的十四點裡第 4、5 點
- 取代：`ui-workflows.md` §5「`chat` 底下逐任務指定不同的模型（v0.10.6）」那四條決定；
  `api-contract.md` 的 `chat.taskModels` 與 `chatTasks`／`taskReadiness`／`readiness` 那一組回應形狀

## 背景

v0.5.0 起模型設定的主鍵是**角色**：`agent`（找來源）、`chat`（歸納與抽取）、`embed`（語意向量），
每個角色一條連線、一個預設模型。v0.10.6 在 `chat` 底下加了逐任務覆寫，**覆寫的只有模型** ——
當時明寫「`baseUrl` 與 `apiKeyEnv` 刻意不能逐任務分岔，否則『本機模型不花錢』這件事會變成按任務而異」。
v0.13.0 又加了一張跨角色的「各任務模型」表。

2026-09-18 使用者第一次真的用，三件事同時浮出來：

1. **「可調用模型」與「各任務模型」是不是重複？** 是 —— 表裡「找來源」「向量」兩列寫的是
   跟上面角色那一格同一個欄位。兩張表講的是同一件事的兩半。
2. **切到 OpenAI 相容端點之後滿頁都是 Ollama 的舊值**：模型清單、版本、格式保證、測試結果
   全是存檔那一條連線的；而模型清單只有存檔之後才會重列，畫面上沒有「先連線看看有哪些模型」這一步。
3. **使用者要的正是被排除的那一格**：歸納角度留在本機 Ollama（量過、不花錢），
   抽取走線上端點（Codex 訂閱的代理，額度大得多）。v0.10.6 的限制讓這件事做不到。

三件事的根是同一個：**使用者要決定的是「每一件事跑在哪裡」，而設定的主鍵是「每一個角色連到哪裡」。**

## 決定

### 一、設定檔 v2：`connections` ＋ `tasks`

```jsonc
// %LOCALAPPDATA%\Cyclosa\providers.json
{ "version": 2,
  "connections": {
    "cli":    { "command": "claude", "args": [] },        // null ＝ 沒設定
    "ollama": { "baseUrl": "http://127.0.0.1:11434", "apiKeyEnv": null },
    "openai": { "baseUrl": "https://…/v1", "apiKeyEnv": "OPENAI_API_KEY_V1" } // null ＝ 沒設定
  },
  "tasks": {
    "find-sources": { "via": "cli",    "model": "" },   // 空 ＝ 用 CLI 自己的預設
    "angles":       { "via": "ollama", "model": "granite4.2:8b" },
    "extract":      { "via": "openai", "model": "codex/gpt-5.5" },
    "embed":        { "via": "ollama", "model": "qwen3-embedding:4b" }
  },
  "diagnostics": { "logModelCalls": false } }
```

**每個任務可以走哪些連線由角色推出來**（`viaOptionsOf`），不另外手寫一份：
找來源只能 `cli`（只有它能自己上網）、嵌入只能 `ollama`（ADR-0009：雲端端點換掉背後的權重不會報錯，
只會讓已經存下來的向量安靜地變爛）、歸納與抽取 `ollama` 或 `openai`。
`via` 不在准許的清單裡就退回第一個准許的 —— 一個指向不存在連線的任務比沒設定更糟。

### 二、v1 讀到就原地升版

`parseConfig` 讀檔與收請求走同一支；`version` 不是 2 的一律當 v1 升：
`chat.transport/baseUrl/apiKeyEnv` 搬到對應的連線，`chat.model` 與 `taskModels` 合成兩個任務各自的模型
（覆寫優先），`agent` 變成 `cli` 連線 ＋ 找來源的模型，`embed` 的位址併進 Ollama 連線。
使用者不必做任何事；下一次存檔就是 v2。

唯一有損的一格：v1 的 chat 與 embed 可以指向**兩個不同的 Ollama 位址**，v2 只有一條 Ollama 連線。
chat 走 Ollama 的話用 chat 的位址，否則用 embed 的。

### 三、沒有「預設的 chat」

`Providers.chatFor(task)` 是跑任務唯一的路；registry 回報的狀態是**一份連線清單＋一份任務清單**，
「缺哪幾樣」逐任務對著那個任務自己的模型算。作業紀錄裡每一次呼叫記的是那個任務走的連線與端點。

### 四、「連線並列出模型」不存檔就列

`POST /api/providers/connections/:kind/models`（`kind` 是 `ollama` 或 `openai`，body 是位址與金鑰變數名）
只列模型、不寫設定檔。Open WebUI 也是這個順序：填位址與金鑰 → 打 `/models` 驗證 → 才選模型。
畫面上位址或金鑰變數一改，舊的清單就作廢、模型欄退回手打 —— 那份清單是對另一條端點列的。

### 五、「實際打一次」逐任務

`POST /api/providers/test` 的 body 從 `{role}` 換成 `{task}`：測的是那個任務實際會跑的那一支。
會不會花錢照那個任務的連線說（CLI 與線上端點會，本機不會）。

## 考慮過、沒有選的

| 選項 | 為什麼沒選 |
|---|---|
| **維持角色為主鍵，只放寬 `baseUrl` 逐任務覆寫** | 設定頁仍然是兩張講同一件事的表；而「覆寫」這個概念本身就是使用者問「是不是重複」的來源 |
| **每個任務自己帶完整的連線（位址＋金鑰變數）** | 同一條連線要在三個地方各打一次，改一個位址要改三格；而金鑰變數名重複出現，就有三個地方可以打錯 |
| **任意多條 OpenAI 相容連線** | 沒有需求證據（使用者只有一條線上端點）。形狀留得出來：`connections.openai` 改成具名清單時，`via` 從種類變成名字 |
| **不升版、兩種形狀並存** | 讀的一方要永遠認兩種形狀，而「存進去的鍵讀不出來」正是這個設定檔踩過的病（v0.10.6 的 `taskModels`）|

## 代價

- **「本機不花錢」現在按任務而異。** v0.10.6 擋掉分岔的理由成立 —— 所以費用改成逐任務說：
  設定頁每一列「實際打一次」旁邊寫會不會花錢，作業紀錄每一次呼叫記著走了哪一條連線。
- **v1 的「chat 與 embed 各自一個 Ollama 位址」合成一個。** 目前沒有人這樣用；真的需要時是連線改成具名清單的那一天。
- **回應形狀整個換掉**：`statuses`／`readiness`／`chatTasks`／`taskReadiness`／`chatModels`／`embedModels`
  換成 `connections` ＋ `tasks`。web 是唯一的呼叫端，同一版一起改；`tests/e2e/online-chat.test.ts`
  與 `provider-tasks.test.ts` 對著真的端點讀新的形狀，型別改名漏接的那種病（2026-09-10 的
  `chatReadiness` → `taskReadiness`）會在那裡紅。

## 什麼情況要重新考慮

- 出現第二條線上端點的需求（例如一條給歸納、一條給抽取）→ `connections.openai` 改成具名清單
- 「研究」（`roadmap.md` Stage 19–24）加的新任務（`plan`、`triage`、`summarize`）要進同一張表 ——
  它們的 `viaOptionsOf` 由角色推，不另寫
