# ┌────────────────────────────────────────────────────────────────┐
# │  如果你是「雙擊這個檔、結果跳出記事本」才看到這一行 ——          │
# │  那不是壞掉。Windows 對 .ps1 的預設動作是「編輯」，不是「執行」。│
# │  要啟動請雙擊專案根目錄的  start_cyclosa.cmd                    │
# └────────────────────────────────────────────────────────────────┘

<#
.SYNOPSIS
    一鍵啟動：檢查 Node、需要時裝相依與建置、起 server、開瀏覽器。

.DESCRIPTION
    **雙擊根目錄的 `start_cyclosa.cmd` 就是跑這一支。** 這支住在 tools\ 底下
    （CONVENTIONS §12：我們自己的腳本全部在 tools\，根目錄只留工具規定位置的檔案）。

    走的是 build 過的產物而不是 dev server —— 驗收要驗的是使用者拿到的那個東西
    （`npm run dev` 另外存在，給開發時的熱重載用）。

    生命週期（ADR-0020）：
      · 埠 7433 被佔用而且那是 Cyclosa 自己 → **開既有的那一個**，不起第二個
      · 埠被別的程式佔用                    → 說清楚是哪一種情況再結束
      · **這個視窗做完就關掉**              → server 在背景繼續跑
      · 要結束 Cyclosa                      → 用畫面右上角那顆「結束 Cyclosa」

    **這個視窗不是 Cyclosa 的開關。** 它是一個檢查清單：檢查完、確認 server
    真的接受連線了、開好瀏覽器，它就沒事了。server 用 `-WindowStyle Hidden`
    起在自己的（隱藏的）主控台上，所以這個視窗關掉不會把它一起帶走。

    上一版是共用主控台（`-NoNewWindow`）＋ 一句「關掉這個視窗就會結束」。
    那樣關得掉，代價是**一個必須一直開著的黑框**，而它唯一的功能是當開關 ——
    v0.9.0 之後畫面上已經有一顆真正的結束鍵了。

.PARAMETER SkipBuild
    跳過建置檢查。改了程式之後不要用。

.PARAMETER Foreground
    server 留在這個視窗裡跑，日誌直接印出來，不自動開瀏覽器。
    **「它開不起來」的時候用這個看完整錯誤。**

.EXAMPLE
    .\tools\Launch.ps1
    .\tools\Launch.ps1 -Foreground
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
# 這支住在 tools\，專案根目錄是它的上一層。
$root = Split-Path -Parent $PSScriptRoot
$port = 7433
$url = "http://127.0.0.1:$port/"

function Write-Step { param([string]$Text) Write-Host "`n=== $Text" -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host "  OK    $Text" -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host "        $Text" -ForegroundColor DarkGray }

# **原生指令寫到 stderr 不等於失敗。**
#
# `vite build` 成功的時候也會印一段「chunk 大於 500 kB」的警告，而在
# `$ErrorActionPreference = 'Stop'` 之下、只要輸出被導向（從另一支腳本呼叫、
# 或在會收集輸出的終端機裡跑），PowerShell 5.1 就會把 stderr 每一行包成
# ErrorRecord，然後**把一個警告變成終止性錯誤** —— 畫面上是「建置失敗」，
# 而 npm 其實回了 0。2026-09-09 實際踩到。
#
# 真正的判準只有一個：**離開碼**。所以原生指令一律走這裡。
#
# **輸出要走 `Out-Host`，不能讓它落回管線。** `& $Command` 的輸出會變成這個函式的
# 回傳值，於是回傳的是「所有輸出 ＋ 離開碼」的一個陣列 —— 而 PowerShell 對陣列的
# `-ne 0` 是**篩選**不是比較，它回傳一個非空陣列，在 `if` 裡永遠為真。
# 症狀是「建置成功但啟動器說建置失敗」，跟這個函式要修的那個坑一模一樣。
function Invoke-Native {
    param([scriptblock]$Command)
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Command | Out-Host } finally { $ErrorActionPreference = $previous }
    return $LASTEXITCODE
}

function Stop-WithMessage {
    param([string]$Title, [string[]]$Lines)
    Write-Host "  失敗  $Title" -ForegroundColor Red
    foreach ($line in $Lines) { Write-Host "        $line" -ForegroundColor Yellow }
    Read-Host '按 Enter 關閉'
    exit 1
}

# 這個 repo 目前的版本。跑著的那一個回報的版本要跟它一樣。
function Get-RepoVersion {
    try {
        $json = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        return $json.version
    } catch { return $null }
}

# 回傳 'cyclosa' / 'stale' / 'other' / 'free'
function Get-PortOwner {
    try {
        $res = Invoke-WebRequest -Uri "$url`healthz" -UseBasicParsing -TimeoutSec 2
        $body = $res.Content | ConvertFrom-Json
        # **一定要看可辨識的欄位。** 只看「有沒有回 200」會把別人跑在 7433 的
        # 服務誤認成自己，然後把瀏覽器開到一個不相干的網頁。
        if ($body.app -eq 'cyclosa') {
            # **而且要看版本。** 一個舊版的 Cyclosa 還跑在 7433 上時，
            # 「已經在執行中，直接開瀏覽器」會把使用者送去看**舊的程式**，
            # 而畫面上沒有任何地方說得出這件事。
            # 2026-09-07 實際踩到：改完程式重建，打開的還是早上那一版。
            $script:runningVersion = $body.version
            $repoVersion = Get-RepoVersion
            if ($repoVersion -and $body.version -and ($body.version -ne $repoVersion)) {
                return 'stale'
            }
            return 'cyclosa'
        }
        return 'other'
    } catch {
        # 連得上但不是我們 → other；完全連不上 → 要再確認埠是不是真的空的
        $listening = $null
        try {
            $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        } catch { }
        if ($null -ne $listening) { return 'other' }
        return 'free'
    }
}

# ── 1. 已經在跑了嗎 ────────────────────────────────────────────────
Write-Step '檢查是否已經在執行'
$owner = Get-PortOwner
if ($owner -eq 'cyclosa') {
    Write-Ok "Cyclosa 已經在 $url 執行中"
    Write-Note '不再起第二個，直接開瀏覽器。'
    Start-Process $url
    exit 0
}
if ($owner -eq 'stale') {
    $pids = (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty OwningProcess -Unique) -join ', '
    Stop-WithMessage "已經有一個**舊版**的 Cyclosa 在 $port 執行中" @(
        "跑著的是 $runningVersion，這份原始碼是 $(Get-RepoVersion)。"
        '直接開瀏覽器會讓你看到舊的程式，而畫面上不會有任何地方說這件事。'
        "先關掉那一個（處理程序 $pids）再重跑："
        "    Stop-Process -Id $pids"
    )
}
if ($owner -eq 'other') {
    Stop-WithMessage "連接埠 $port 被別的程式佔用" @(
        '那個程式不是 Cyclosa（/healthz 沒有回傳 app=cyclosa）。'
        "先關掉佔用 $port 的程式，或用這個指令查是誰："
        "    Get-NetTCPConnection -LocalPort $port -State Listen | Select-Object OwningProcess"
    )
}
Write-Ok "連接埠 $port 可用"

# ── 2. Node ────────────────────────────────────────────────────────
# **不信 PATH 上剛好有什麼。** node:sqlite 要 Node 24，而錯的版本會在很後面才炸。
Write-Step '檢查 Node'
$node = if ($env:CYCLOSA_NODE) { $env:CYCLOSA_NODE } else { 'node' }
try { $nodeVersion = & $node --version 2>$null } catch { $nodeVersion = $null }
if (-not $nodeVersion) {
    Stop-WithMessage '找不到 Node' @(
        '這個專案需要 Node 24。安裝之後重開一次，或指定路徑：'
        '    setx CYCLOSA_NODE "C:\path\to\node.exe"'
    )
}
$major = [int]($nodeVersion -replace '^v(\d+)\..*$', '$1')
if ($major -ne 24) {
    Stop-WithMessage "Node 版本是 $nodeVersion，需要 24.x" @(
        '.node-version 與 package.json 的 engines 都宣告 24。'
        'node:sqlite 是這條下界唯一的理由（見 docs\environment\versions.md）。'
        '裝好 24 之後指定它：'
        '    setx CYCLOSA_NODE "C:\path\to\node24\node.exe"'
    )
}
Write-Ok "Node $nodeVersion"

# ── 3. 相依 ────────────────────────────────────────────────────────
Write-Step '檢查相依'
if (-not (Test-Path (Join-Path $root 'node_modules'))) {
    Write-Host '  node_modules 不存在，執行 npm ci…' -ForegroundColor Yellow
    Push-Location $root
    try {
        if ((Invoke-Native { & npm ci }) -ne 0) {
            Stop-WithMessage 'npm ci 失敗' @('先手動跑一次看完整訊息：', "    cd $root", '    npm ci')
        }
    } finally { Pop-Location }
}
Write-Ok '相依就緒'

# ── 4. 建置 ────────────────────────────────────────────────────────
# 產物比原始碼舊就重建。**比對時間戳而不是每次都建** —— 每次都建會讓
# 一鍵啟動慢到使用者開始想繞過它，而繞過去的那條路沒有上面那些檢查。
Write-Step '檢查建置產物'
$serverEntry = Join-Path $root 'dist\main.js'
$webIndex = Join-Path $root 'web\dist\index.html'

function Get-NewestWrite {
    param([string]$Path, [string[]]$Include)
    if (-not (Test-Path $Path)) { return [datetime]::MinValue }
    $items = Get-ChildItem -Path $Path -Recurse -File -Include $Include -ErrorAction SilentlyContinue
    if (-not $items) { return [datetime]::MinValue }
    return ($items | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum
}

$needBuild = $false
if ($SkipBuild) {
    Write-Note '-SkipBuild：跳過建置檢查'
} elseif (-not (Test-Path $serverEntry) -or -not (Test-Path $webIndex)) {
    $needBuild = $true
    Write-Host '  還沒有建置產物' -ForegroundColor Yellow
} else {
    $srcNewest = Get-NewestWrite -Path (Join-Path $root 'src') -Include '*.ts', '*.sql'
    $webNewest = Get-NewestWrite -Path (Join-Path $root 'web\src') -Include '*.ts', '*.vue', '*.css'
    $builtServer = (Get-Item $serverEntry).LastWriteTimeUtc
    $builtWeb = (Get-Item $webIndex).LastWriteTimeUtc
    if ($srcNewest -gt $builtServer -or $webNewest -gt $builtWeb) {
        $needBuild = $true
        Write-Host '  原始碼比產物新' -ForegroundColor Yellow
    }
}

if ($needBuild) {
    Push-Location $root
    try {
        if ((Invoke-Native { & npm run build }) -ne 0) {
            Stop-WithMessage '建置失敗' @('先手動跑一次看完整訊息：', "    cd $root", '    npm run build')
        }
    } finally { Pop-Location }
}
Write-Ok '產物就緒'

# ── 5. 起 server ───────────────────────────────────────────────────
# **直接跑 node dist\main.js，不透過 npm.cmd。**
# npm 會再生一層子行程，我們拿到的 process 是 npm 那一層 ——
# 砍掉它砍不到真正的 server，於是「關掉視窗」之後 7433 還在被佔用。
# rubricator 2026-09-04 實測踩過，記在它的 docs\lessons.md。
Write-Step '啟動'

# **背景執行沒有主控台，所以 server 的輸出要有個去處。**
# 放在指標檔旁邊而不是資料根底下 —— 「資料根讀不到」正是最需要看日誌的那一種故障，
# 而一個存在資料根裡的日誌在那個情況下寫不出來。
$logDir = Join-Path $env:LOCALAPPDATA 'Cyclosa\logs'
$logFile = Join-Path $logDir 'server.log'
try {
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    # 每次啟動留兩份：這一次與上一次。**不做輪替就會長成一個沒有人會刪的檔案。**
    if (Test-Path -LiteralPath $logFile) {
        Move-Item -LiteralPath $logFile -Destination (Join-Path $logDir 'server.prev.log') -Force
    }
    $env:CYCLOSA_LOG_FILE = $logFile
} catch {
    # 日誌寫不了不該讓程式起不來 —— 但要說出來，不然「怎麼沒有日誌」會變成第二個謎。
    Write-Note "寫不了日誌（$logDir），這一次不留紀錄。"
    $logFile = $null
}

if ($Foreground) {
    # 前景模式：留在這個視窗裡。**這條路是給「它為什麼開不起來」用的**，
    # 所以不自動開瀏覽器 —— 要看的是這裡印出來的東西。
    Write-Note "前景模式：server 跑在這個視窗裡，Ctrl+C 結束。網址是 $url"
    Write-Host ''
    exit (Invoke-Native { & $node $serverEntry })
}

# **-WindowStyle Hidden：自己的主控台，而且是隱藏的。**
#
# 這是三種做法裡唯一兩件事都成立的：
#
# | 做法 | 有沒有黑框 | 關掉啟動器之後還活著嗎 |
# |---|---|---|
# | `-NoNewWindow`（v0.8.1–v0.9.0）| 有，而且要一直開著 | 不會 —— 共用主控台，關窗等於送 CTRL_CLOSE |
# | `-WindowStyle Minimized` | 有（縮在工作列）| 會 |
# | `-WindowStyle Hidden` | **沒有** | **會** |
#
# 走 ShellExecute 的那兩個不繼承這個主控台，所以這個視窗可以先走 ——
# 而共用主控台的那一個，會讓視窗一直開到 server 結束為止。
# （webscouts 的 `_scripts\Start-WebScouts.ps1` 是同一個結論，理由也一樣。）
$proc = Start-Process -FilePath $node -ArgumentList @($serverEntry) `
    -WorkingDirectory $root -PassThru -WindowStyle Hidden

function Stop-WithLog {
    param([string]$Title, [string[]]$Lines)
    $extra = @()
    if ($logFile -and (Test-Path -LiteralPath $logFile)) {
        $tail = Get-Content -LiteralPath $logFile -Tail 15 -Encoding UTF8
        if ($tail) { $extra = @('', 'server 最後印的幾行：') + $tail }
        $extra += @('', "完整紀錄：$logFile")
    }
    Stop-WithMessage $Title ($Lines + $extra)
}

# **等它真的接受連線，不是傻等固定秒數。**
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 400
    if ($proc.HasExited) {
        Stop-WithLog 'server 啟動後隨即結束' @(
            '看完整錯誤：'
            "    cd $root"
            '    .\tools\Launch.ps1 -Foreground'
        )
    }
    if ((Get-PortOwner) -eq 'cyclosa') { $ready = $true; break }
}
if (-not $ready) {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Stop-WithLog '等不到 server 回應' @("預期位置：$url", '看完整錯誤：.\tools\Launch.ps1 -Foreground')
}

Write-Ok "已啟動：$url"
Start-Process $url

Write-Host ''
Write-Host '  資料存在專案外的資料根目錄 —— 第一次啟動會請你選一個位置。' -ForegroundColor DarkGray
# **要結束的路只有一條，而且不在這裡。** 這個視窗等一下就不見了，
# 所以它不能是關掉 Cyclosa 的方法 —— 那件事在畫面右上角。
Write-Host '  要結束 Cyclosa，用畫面右上角的「結束 Cyclosa」。' -ForegroundColor DarkYellow
if ($logFile) { Write-Host "  server 的紀錄：$logFile" -ForegroundColor DarkGray }
Write-Host ''
exit 0
