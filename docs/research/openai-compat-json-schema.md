# OpenAI 相容端點的 JSON 格式支援

**這一份回答 v0.18.0 的第一條收尾條件：「動手前先量目標端點的 `json_schema` 支援程度」。**
2026-09-11。可信度 **A 級**（對著真的端點實測，腳本與原始紀錄在下面）。

> **2026-09-18 補**：第一個線上端點量到了（見「結果三」），而**它抓到一個我們自己的洞** ——
> 三份真的 schema 少了 `additionalProperties: false`，所以嚴格模式的端點一律回 400。
> 下面這一段是 2026-09-11 寫的，留著是因為它解釋了為什麼那個洞能活到現在。

> **先說沒量到的：這台機器上沒有任何線上服務的金鑰**，所以一個線上端點都沒有量。
> 量到的是這台機器上**唯一一個 OpenAI 相容端點** —— 本機 Ollama 0.33.2 的 `/v1`。
>
> 這件事改變的是設計，不是結論的可信度：**既然量不到使用者會接的那一個端點，
> 程式就不能帶一張「哪家支援什麼」的表** —— 它改成每個「端點＋模型」各自量一次，
> 帶著時間存下來（`provider-checks.json`）。有金鑰的人要事先量，
> 用 `tools/research/probe-json-mode.ts`（出貨的那一支程式碼，不是另一份實作）。

---

## 量測設計

問題不是「端點收不收 `response_format`」，而是**收了之後有沒有照做**。
一個收了卻安靜忽略的端點，在形狀上看不出來 —— 除非題目設計成**只有照做才答得出來**。

| 元件 | 內容 | 為什麼 |
|---|---|---|
| schema | `probe` 只有一個允許值 `"cyclosa-json-schema-probe"`；`n` 必須剛好是 7；不准多欄位 | 模型不可能自己猜到那個字串 |
| 提示詞 | 「用一句話介紹你自己。**不要用 JSON**，用一般的句子。」 | 往反方向拉 —— 沒被 schema 約束的模型會回一句自我介紹 |
| 對照組 | 同一句提示詞，**不帶** `response_format` | 確認提示詞真的在往外拉 |

判準：輸出**逐欄符合** schema（`conformsTo`）才算支援。
「是一份 JSON」不算 —— 那是下一級（`json_object`）的判準。

## 結果一：Ollama 的 `/v1` 支援 `json_schema`，而且真的套用

草稿腳本，溫度 0，每個模型 3 次：

| 模型 | 對照組回 JSON | `json_schema` 符合 | `json_object` 是物件 |
|---|:--:|:--:|:--:|
| `qwen3.5:4b` | 0/3 | **3/3** | 3/3 |
| `granite4.2:8b` | 0/3 | **3/3** | 3/3 |

對照組三次都是一句自我介紹（「我是一個由通義實驗室研發的超大型語言模型……」），
帶了 schema 之後三次都是 `{"probe": "cyclosa-json-schema-probe", "n": 7}`。

**然後用出貨的程式碼再量一次**（`tools/research/probe-json-mode.ts`，走 `chat-openai.ts` 的 `checkJson`）：

| 模型 | 結果 | 對方說的理由 |
|---|---|---|
| `qwen3.5:4b` | `schema` 3/3 | —— |
| `granite4.2:8b` | `schema` 3/3 | —— |
| **`qwen3-embedding:4b`** | **`none` 3/3** | `"qwen3-embedding:4b" does not support chat` |

第三列是**刻意放進去的**：`none` 那一支需要在一個真的端點上被走到一次。
而它順便證實了一件設計時沒想到的事 ——

> **`/v1/models` 會把嵌入模型一起列出來**，而它們根本不能對話。
> 使用者從下拉選單選得到它。量測正確地回了 `none`，並且把對方自己說的原因帶出來；
> 所以 `PROVIDER_JSON_UNSUPPORTED` 的訊息說的是「**這個模型**在這個端點上」，
> 不是「這個端點」—— 量測本來就是按「端點＋模型」記的。

### 這推翻了一句寫在程式碼裡的話

`chat-ollama.ts` 的檔頭原本寫著「OpenAI 相容那條路的 `response_format` **只到 `json_object`**」，
那是「為什麼本機 Ollama 走 `/api/chat` 不走 `/v1`」的理由。
**在 Ollama 0.33.2 上它不成立了。**

roadmap 的 Stage 16 那一節早就警告過：那句話「是一個實測結果，不是一條通則」。
它變成假話的方式不是被推廣到別家，是**同一家升版了**。
**一句沒有日期的量測結果，會在對方升版之後變成假話** ——
所以這一次的設計裡，每一筆量測都帶著時間。

## 結果二：本機 Ollama 仍然要走原生協定，理由換了一個

既然 `/v1` 也支援 `json_schema`，本機 Ollama 還需要原生那條嗎？控制一個變因再量：
同一題、同一份 schema，`qwen3.5:4b`，三條路各 3 次：

| 路 | 時間 | 思考的字數 |
|---|--:|--:|
| 原生 `/api/chat`，`think: false` | **0.41–0.59 秒** | **0** |
| 原生 `/api/chat`，`think: true` | 4.11–4.21 秒 | 2,935 |
| `/v1/chat/completions` | 4.10–4.23 秒 | 2,935 |

**`/v1` 的行為跟原生 `think: true` 一模一樣** —— OpenAI 協定裡沒有「關掉思考」這個欄位。
而那個欄位在 2026-09-09 量過是決定性的（`chat-choice.md`：`qwen3.5:4b` 抽取 4/6 → **6/6**、
63 秒 → **5 秒**）。另外 `num_ctx` 也只有原生那條送得出去。

所以本機 Ollama 留在原生協定，**理由從一句過期的話換成一個量得到的數字**：慢 9 倍。

## 結果三：第一個線上端點（2026-09-18）—— 而它抓到一個我們自己的洞

**這是這份文件最上面那句「一個線上端點都沒有量」失效的日子。** 使用者拿到一把
第三方代理（kano-proxy，OpenAI 相容）的金鑰，量測對象是 `codex/gpt-5.5`。

| 步驟 | 結果 |
|---|---|
| `GET /openai/v1/models` | 200，5 個模型（與使用者畫面上看到的一致）|
| 格式量測（`checkJson`，探針 schema）| **`schema`** —— 送 `json_schema` 有被真的套用 |
| 接著「實際打一次」 | **失敗**：`PROVIDER_JSON_UNSUPPORTED` |

**兩句話互相矛盾，而矛盾的是我們自己。** 直接對端點打一次就看到原因：

```
HTTP 400 invalid_json_schema
"Invalid schema for response_format 't': In context=(),
 'additionalProperties' is required to be supplied and to be false."
```

OpenAI 的嚴格模式對**每一個物件節點**要求 `additionalProperties: false`，
而且 `required` 要列出全部屬性。**探針那份 schema 有寫**（所以量測過了），
**三份真的 schema 一份都沒有**（角度、抽取、找來源）。

於是 v0.18.0 宣稱的「可以接任何 OpenAI 相容端點」，**對嚴格模式的端點從來沒有成立過** ——
而它沒有被發現的原因就寫在這份文件的第一段：**在那之前一個線上端點都沒量過。**
量得到的唯一那個（Ollama 的 `/v1`）對這兩條寬鬆，所以它一直是綠的。

**更糟的是那句錯誤訊息**：`chat-openai.ts` 對「`schema` 模式下被 400」的解釋是
「量測舊了，端點大概改了規格」—— 它把我們自己的 schema 問題講成對方的問題。

**怎麼修的**（v0.22.1）：`strictify()`（`domain/provider/schema-check.ts`）在**送出去之前**
補上那兩條，**不動那三份 schema** —— 那是某個端點的要求，不是我們的規則，
而寫進 schema 會連帶讓 `conformsTo` 對本機那條路收緊（多一個欄位就整份判不過）。
修完之後：三份真的 schema 直接送這個端點都是 **HTTP 200**，「實際打一次」也過了（5.1 秒）。

| 端點＋模型 | 格式保證 | 量的時間 | 備註 |
|---|---|---|---|
| 第三方代理的 `/openai/v1`（網域不列） ＋ `codex/gpt-5.5` | **`schema`** | 2026-09-18 | 第三方代理，非官方 OpenAI。`/models` 不回 `context_length`，所以 context 顯示 0（＝不知道，閘門放行）|

> **這個端點不回報 context 長度，也不回報金額。** 前者讓 `TASK_EXTRACT` 的
> 「ctx ≥ 24k」閘門對它永遠放行 —— **不是它通過了，是我們不知道**；
> 後者讓 `costUsd` 是 `null`。兩件事都在畫面上看得到，但都**不是量出來的保證**。

## 對設計的影響

| 決定 | 依據 |
|---|---|
| 不帶「哪家支援什麼」的表，**每個端點＋模型各量一次** | 量不到線上端點；而量得到的那一個，舊結論已經在升版後失效 |
| 量測結果帶時間、畫面照實顯示、按「實際打一次」會重量 | 「多久算舊」沒有誠實的數字（`json-checks.ts` 檔頭）|
| 三級：`schema`／`object`／`none` | 結果一的三列正好各示範一種（`object` 由假端點演，見下）|
| `object` 模式由這一側事後驗證，而且**說出來** | ADR-0030 |
| 本機 Ollama 不改走 `/v1` | 結果二 |

**「收了但安靜忽略」與「直接拒絕」這兩種行為，這台機器上沒有一個端點演得出來**，
所以由 `tests/infrastructure/chat-openai.test.ts` 的假端點演。
那是測試，不是量測 —— 它證明程式對那兩種行為的處理是對的，
**不證明真的有哪一家是那樣**。

## 怎麼重量

```powershell
# 本機 Ollama（免費）
npx tsx tools/research/probe-json-mode.ts --base-url http://127.0.0.1:11434/v1 --model qwen3.5:4b

# 線上端點（會計費；金鑰只給環境變數的名字，值不經過命令列）
npx tsx tools/research/probe-json-mode.ts --base-url https://<那一家>/v1 --model <名稱> --key-env <變數名>
```

**不會寫進使用者的 `provider-checks.json`** —— 量測用臨時的 `LOCALAPPDATA`，跑完就刪。

## 沒有做的

- **任何一個線上端點**。要量的那一天，結果補在這一份的「結果一」底下，標日期
- **`strict: true` 以外的寫法**。OpenAI 的 `json_schema` 有 `strict` 開關，這裡一律送 `true`；
  關掉它的行為沒有量
- **Ollama 以外的本機伺服器**（vLLM、LM Studio、llama.cpp 的 server）。它們說同一種協定，
  但對 `response_format` 的支援各自不同 —— 那正是為什麼要按端點量
