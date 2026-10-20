# gpt-oss 抽取量測（issue #10）

**狀態：判準已定，待使用者在 AMD 端點可用時執行。** 本文件不推薦模型，也不設定通過門檻；記錄實際輸出供人比較。

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

| 項目 ID | 服務 | 模型 | Schema 有效 | 關聯數 | 引文命中／總數 | 秒數 | 錯誤碼 |
|---|---|---|---|---:|---|---:|---|
| <項目 ID 1> | OpenAI 相容 API | gpt-oss-120b | — | — | — | — | — |
| <項目 ID 1> | Ollama | gemma4:12b | — | — | — | — | — |
| <項目 ID 2> | OpenAI 相容 API | gpt-oss-120b | — | — | — | — | — |
| <項目 ID 2> | Ollama | gemma4:12b | — | — | — | — | — |
| <項目 ID 3> | OpenAI 相容 API | gpt-oss-120b | — | — | — | — | — |
| <項目 ID 3> | Ollama | gemma4:12b | — | — | — | — | — |