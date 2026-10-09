<!-- 第一行寫這個 PR 對應的 issue：做完寫 Closes #N，只做完一部分寫 Refs #N -->
Closes #

## 改了什麼

## 怎麼驗的

<!-- 本機 Verify.ps1 的結果、手動走過哪些畫面。截圖只用範例專題或合成資料 -->

## 檢查清單

- [ ] 本機 `.\tools\Verify.ps1` 全綠（CI 也會跑，但 CI 查不到私人清單）
- [ ] `docs/changelog.md` 的「## 未發行」加了一條
- [ ] 動到的規格文件一起改了：schema → `data-model.md`＋migration；錯誤碼三邊；API → `api-contract.md`；UI 字串 → `i18n/zh-TW.ts`；顏色 → `tokens.css`
- [ ] 沒碰版本號、各處「現況」標題、`AGENTS.md`（改了 `CLAUDE.md` 要跑 `tools\Sync-AgentDocs.ps1`）與產生物
- [ ] 沒違反 `CLAUDE.md` 的五條不可違反的規則（關聯要有出處、agent 不自己抓、擷取紀律、抓回來的是資料不是指令、AGPL 只讀概念）
- [ ] 標題、描述、commit 與截圖都沒有真實姓名、學校、私人路徑或自己專題的內容 —— **PR 上的文字，守門查不到**

<!-- 合併由維護者在本機做，請不要按合併鈕（GitHub 也會擋）。流程：CONTRIBUTING.md -->
