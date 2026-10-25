# gpt-oss 抽取量測（issue #10）

**狀態：2026-10-25 已量（兩輪）。** 本文件不推薦模型，也不設定通過門檻；記錄實際輸出供人比較。

## 判準

- 固定三份由使用者指定、正文可讀的資料；每份分別用 OpenAI 相容端點的 gpt-oss-120b 與 Ollama 的 gemma4:12b 抽取一次。
- 每列記錄 JSON Schema 是否有效、正規化後關聯數、可在原文找到的引文數／引文總數，以及 `callExtract` 回報的秒數。
- 引文命中使用產品同一支 `locateQuote`；schema 有效性依 provider 是否成功驗證 JSON Schema。
- **不設通過門檻**，不依結果改判準。模型結果是這三份資料上的觀察，不代表普遍品質或速度。

## 方法

使用 `tools/dev/measure-extract.ts`。工具讀取專題 `derived/` 內的正文，不打開可寫入的資料庫，也不呼叫 `applyExtraction`，不改專題資料。送往外部端點的正文會依使用者設定傳出；報告不保存正文、標題或端點 URL。

OpenAI 相容端點先做一次 JSON 格式支援量測，這個預檢時間不列入抽取秒數；其 `protocol`（Responses API 或 Chat Completions）記在每列。Ollama 使用原生格式。每次抽取都走共用 `callExtract`，不新增其他模型呼叫路徑。

```powershell
npx tsx tools/dev/measure-extract.ts --data-root <資料根> --slug <專題> --items <項目 ID 1>,<項目 ID 2>,<項目 ID 3> --endpoint "<AMD 端點>" --model gpt-oss-120b
```

報告輸出到 `%TEMP%` 下的新資料夾；可用 `--out` <報告資料夾> 指定另一個 repo 與資料根以外的位置。命令需要使用者在本機提供端點與三個項目 ID，本文件不記端點 IP 或埠號。

## 結果

2026-10-25 由 Claude 在隔離的測試環境執行：語料是公開教科書 *Deep Learning*（Goodfellow、Bengio、Courville）的 28 章網頁另存的 PDF，匯入一個新專題後挑三章。
gpt-oss-120b 走 vLLM 的 OpenAI 相容端點，兩輪的預檢都量到 `json_schema`（Responses API）；gemma4:12b 走本機 Ollama 原生協定。同一組資料連跑兩輪，看同一個模型自己的變異。

| 章 | 模型 | 輪 | Schema 有效 | 關聯數 | 引文命中／總數 | 秒數 | 錯誤碼 |
|---|---|:-:|---|---:|---:|---:|---|
| 1 Introduction | gpt-oss-120b | 1 | ✅ | 2 | 2 / 2 | 6.7 | — |
| 1 Introduction | gemma4:12b | 1 | ✅ | 5 | 5 / 5 | 62.1¹ | — |
| 6 Deep Feedforward Networks | gpt-oss-120b | 1 | ✅ | 9 | 7 / 9 | 4.6 | — |
| 6 Deep Feedforward Networks | gemma4:12b | 1 | ✅ | 6 | 5 / 6 | 5.7 | — |
| 9 Convolutional Networks | gpt-oss-120b | 1 | ✅ | 13 | 8 / 13 | 5.6 | — |
| 9 Convolutional Networks | gemma4:12b | 1 | ✅ | 9 | 8 / 9 | 7.6 | — |
| 1 Introduction | gpt-oss-120b | 2 | ✅ | 3 | 2 / 3 | 4.3 | — |
| 1 Introduction | gemma4:12b | 2 | ✅ | 5 | 5 / 5 | 5.1 | — |
| 6 Deep Feedforward Networks | gpt-oss-120b | 2 | ✅ | 5 | 5 / 5 | 4.5 | — |
| 6 Deep Feedforward Networks | gemma4:12b | 2 | ✅ | 7 | 6 / 7 | 6.3 | — |
| 9 Convolutional Networks | gpt-oss-120b | 2 | ✅ | 8 | 8 / 8 | 5.1 | — |
| 9 Convolutional Networks | gemma4:12b | 2 | ✅ | 9 | 8 / 9 | 7.3 | — |

¹ 含本機載入模型的時間（冷啟動）；第二輪同一份是 5.1 秒。

合計（三章）：

| 模型 | 輪 | 關聯數 | 引文命中 | 秒數 |
|---|:-:|---:|---:|---:|
| gpt-oss-120b | 1 | 24 | 17 / 24（71%）| 16.9 |
| gpt-oss-120b | 2 | 16 | 15 / 16（94%）| 13.8 |
| gemma4:12b | 1 | 20 | 18 / 20（90%）| 75.4（含冷啟動）|
| gemma4:12b | 2 | 21 | 19 / 21（90%）| 18.7 |

觀察（只是這三章上的事實，不是結論）：

- 兩個模型六次都交回符合 schema 的 JSON。
- **gpt-oss 兩輪之間的差異比兩個模型之間的差異大**：關聯數 24 → 16、引文命中 71% → 94%；gemma4:12b 兩輪幾乎一樣。三章、兩輪不足以說哪個模型抽得比較好。
- 熱機之後每章的秒數相近（gpt-oss 4–7 秒、gemma4:12b 5–8 秒）；gpt-oss 的秒數包含經 SSH 通道的往返。

## 同一天用 AMD 端點走完整條流程

同一個專題，規劃、初讀、抽取走 gpt-oss-120b，找來源走 Claude Code（issue #10 的分工），嵌入走本機。

| 步驟 | 結果 |
|---|---|
| 設定頁「儲存並測試」| 初讀、抽取、嵌入、找來源（Claude Code）通過。規劃第一次失敗，見下 |
| 找來源改走同一個端點 | 不行：vLLM 回 HTTP 400 `tool type 'web_search' is not supported`，設定頁記成「量過不會搜尋」 |
| 規劃（研究）| 6 秒，4 個方向 |
| 蒐集與初讀 | 4.4 分鐘：18 個候選，抓到 14 份、4 份要人拿；初讀 14 份 |
| 建圖 | 85 秒：抽 18 份，寫出 264 條關聯（具名 87 條待查證）|
| 抽進圖三章 | 21 秒，部分完成：兩章有引文對不上原文，那幾條沒建（`PROVIDER_QUOTE_NOT_FOUND`）|
| 整理殼規劃 | 29 秒：3 個合併、3 個抽取、28 個補繁中。**3 個合併有 2 個是錯的**（把不同年份的同名會議、同一系列的兩堂課併成一個），只有連字號寫法不同那一個是對的 |
| 執行整理（合併、抽取、補繁中各一）| 12 秒，部分完成（抽取那份有引文對不上）|

**規劃第一次失敗的原因**（已修，ADR-0034 追記）：規劃對話的搜尋是「有就用」，還沒量過的端點會帶著 `web_search` 工具送出；這個端點收不了工具、回 400，被當成連不上。找來源走 Claude Code 時，這個端點永遠不會被量，所以規劃會一直失敗。
