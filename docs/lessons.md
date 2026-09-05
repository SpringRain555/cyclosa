# 失敗紀錄

**append-only。** 修好之後不要刪掉條目 —— 這份文件的價值在於「踩過什麼」，
不是「現在有什麼問題」。已解決的就在「怎麼修的」寫清楚。

每一條五個欄位。**影響範圍**是選填的，標了「全域」的條目會被
`Update-Dashboard.ps1` 掃進 dashboard 的「待提升」區（CONVENTIONS §14 上行）。

> 這個專案還沒有程式，所以下面兩條都是**建立骨架時**踩到的工具鏈問題，
> 不是這個工具本身的 bug。

---

## `node -e` 的引號在 PowerShell 與 Git Bash 底下都會被吃掉

**日期**：2026-09-05

**症狀**：同一段 JS 用 `node -e` 執行，兩種 shell 各壞一種：

```
# Git Bash：反斜線被 shell 先吃掉一層
const p='...'+r.replace(/\/g,'/');
                        ^^^^^^
SyntaxError: Invalid or unexpected token

# PowerShell 5.1：內層的雙引號被吃掉，字串提早結束
like %FTS5% \).get();console.log('
Expected ',', got '<eof>'
```

**原因**：`node -e` 的內容要穿過兩層跳脫（shell 一層、JS 一層），而兩種 shell
對反斜線與引號的規則不同。**這不是寫錯，是這個用法本身就脆弱** ——
只要 JS 裡出現 `\`、`"`、`'` 其中之一就有機會壞，而且錯誤訊息指向 JS 語法，
看不出真正的原因在 shell。

**怎麼修的**：**把腳本寫成獨立的 `.mjs` 檔再 `node <檔案>`。**
臨時用的就寫進暫存資料夾。同一輪裡這個問題出現三次，換成檔案之後一次都沒再遇到。

**影響範圍**：全域

## PowerShell 5.1 的 `Get-Content -Raw` 把 UTF-8 讀成 ANSI，中文全毀

**日期**：2026-09-05

**症狀**：`Get-Content package.json -Raw | ConvertFrom-Json` 丟出
`Invalid object passed in, ':' or '}' expected`，而印出來的內容裡中文變成
`?祆??芸??犖?蝞∠?撌亙???Ｙ?`。**檔案本身完全正常** —— 同一個檔案 `node -p` 讀得好好的。

**原因**：PS 5.1 的 `Get-Content` 預設用系統 ANSI codepage（在這台機器是 Big5），
不是 UTF-8。UTF-8 的中文位元組被當成 Big5 解讀，於是字全錯，JSON 也就解析失敗。
**錯誤訊息說的是 JSON 壞掉，而 JSON 沒有壞。**

**怎麼修的**：讀 UTF-8 檔案時二選一 ——
`Get-Content <檔> -Raw -Encoding UTF8`，或乾脆用 `node -p "require('./x.json').y"`。

> 這條與 CONVENTIONS §8 的 BOM 規則**是兩件事**，很容易混。
> §8 管的是「寫檔要不要加 BOM」，這一條管的是「讀檔用什麼編碼解」。
> 一個沒有 BOM 的 UTF-8 檔案完全合法，而 PS 5.1 照樣會讀壞它。

**影響範圍**：全域
