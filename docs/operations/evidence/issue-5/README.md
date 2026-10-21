# Issue #5 合成介面驗證

本資料夾的截圖使用產品的 `ConsolidateShellPanel` 與 `MergedEntities` 元件，以及共用樣式；外層為隔離的合成預覽頁。
API 回應由記憶體內的假資料提供，沒有啟動正式 App、讀寫使用者專題或呼叫模型。

- `review.png`：合併可勾選、預設不勾，執行按鈕停用。
- `unmerge.png`：模擬勾選與執行回應後，重新載入可看到實體面板的取消入口。
- `restored.png`：點「取消合併」後，併入項目消失。

這些截圖只驗證介面接線與呈現，不代表真實模型品質或正式 App 的完整人工驗收。
實際候選篩選、資料庫合併／取消、來源關聯還原、失效與部分失敗，另由 `tests/e2e/consolidate-merge.test.ts` 驗證；
合併與抽取混合執行順序由 `tests/e2e/consolidate.test.ts` 驗證。
