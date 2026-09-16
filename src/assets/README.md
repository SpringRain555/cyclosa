# `src/assets/` —— 執行期要讀得到的非程式檔

`tsc` 只處理 `.ts`，所以這一層的東西由 `tools/build/copy-assets.mjs`
複製到 `dist/assets/`。**漏了那一步的症狀是「第一次啟動沒有範例專題，
而且沒有人說為什麼」。**

## `sample-corpus.json` —— 範例專題的語料

八條中華民國法律的**條文原文**，外加手寫的圖形狀（六個實體、十二條關聯）。
`src/application/sample-service.ts` 讀它。

### 出處與授權

| | |
|---|---|
| 資料集 | 中文法規＿法律資料檔下載 |
| 資料集頁 | <https://data.gov.tw/dataset/18289> |
| 提供機關 | 法務部資訊處 |
| 下載端點 | `https://sendlaw.moj.gov.tw/PublicData/GetFile.ashx?DType=XML&AuData=CF` |
| 授權 | **政府資料開放授權條款－第 1 版**（<https://law.moj.gov.tw/Service/Copyright.aspx>）|
| 資料集更新日 | 2026-08-28 |
| 取得日 | 2026-09-11 |

**兩個獨立的依據都成立**：

1. **著作權法第 9 條** —— 憲法、法律、命令或公文**不得為著作權之標的**。
   條文原文從一開始就沒有著作權，重製與再散布不需要任何人同意
2. **政府資料開放授權條款第 1 版** —— 無償、非專屬、可再授權、
   不限時間地域、**不會嗣後撤回**；義務是**註明出處**

出處寫進每一份語料的內容本身（`articleMarkdown`），
而每一個 `item` 的 `requested_url` 是**該條文自己的網址**，不是整部法規的。

完整查證（含為什麼不爬 `law.moj.gov.tw`）在
`docs/research/sample-corpus-licence.md`。

### 一件要說清楚的事

語料檔裡 `origin: 'human'` 的那四條關聯，在產生出來的專題裡會是「已確認」。
**它們是示範資料，不是任何人真的裁決過的紀錄。**
這句話同時出現在設定頁的「資料位置」分頁上。

### 要改它的時候

- **引文（`quote`）必須在條文原文裡逐字存在。** 產生器會自己在正文裡找位置
  （ADR-0021：位置一律自己找，不採信寫進來的）；找不到就**不寫那一條出處**，
  而 `tests/e2e/sample-case.test.ts` 有一條在驗「每一條關聯都有出處」
- 出處不一定長在邊的來源節點上 —— 用 `evidenceFrom` 指定
  （例：`cr52 → cr64` 的證據在 `cr64` 的條文裡，因為是 §64 列舉了 §52）
- 換語料要重走一次授權查證，理由見 `sample-corpus-licence.md` 的「重查的時機」
