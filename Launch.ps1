# ┌────────────────────────────────────────────────────────────────┐
# │  如果你是「雙擊這個檔、結果跳出記事本」才看到這一行 ——          │
# │  那不是壞掉。Windows 對 .ps1 的預設動作是「編輯」，不是「執行」。│
# │  要啟動請雙擊同一個資料夾裡的  Start Cyclosa.cmd                │
# └────────────────────────────────────────────────────────────────┘

<#
.SYNOPSIS
    一鍵啟動：檢查 Node、需要時裝相依與建置、起 server、開瀏覽器。

.DESCRIPTION
    **雙擊 `Start Cyclosa.cmd` 就是跑這一支。**

    走的是 build 過的產物而不是 dev server —— 驗收要驗的是使用者拿到的那個東西
    （`npm run dev` 另外存在，給開發時的熱重載用）。

    生命週期（ADR-0020）：
      · 埠 7433 被佔用而且那是 Cyclosa 自己 → **開既有的那一個**，不起第二個
      · 埠被別的程式佔用                    → 說清楚是哪一種情況再結束
      · 關掉這個視窗                        → server 一起結束

.PARAMETER SkipBuild
    跳過建置檢查。改了程式之後不要用。

.EXAMPLE
    .\Launch.ps1
#>
[CmdletBinding()]
param(
    [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$port = 7433
$url = "http://127.0.0.1:$port/"

function Write-Step { param([string]$Text) Write-Host "`n=== $Text" -ForegroundColor Cyan }
function Write-Ok { param([string]$Text) Write-Host "  OK    $Text" -ForegroundColor Green }
function Write-Note { param([string]$Text) Write-Host "        $Text" -ForegroundColor DarkGray }

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
        & npm ci
        if ($LASTEXITCODE -ne 0) {
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
        & npm run build
        if ($LASTEXITCODE -ne 0) {
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
# **-NoNewWindow：跟這個視窗共用同一個主控台。**
#
# 第一版是 `-WindowStyle Minimized`，而那有兩個問題，第二個嚴重得多：
#
# 1. 多一個沒有人會去看的視窗
# 2. **子程序有自己的主控台，所以按 X 關掉這個視窗殺不到它** ——
#    實測過：這樣起的子程序在父程序死掉之後還活著。
#    於是畫面上那句「關掉這個視窗就會結束 Cyclosa」只有按 Enter 那半是真的，
#    而剩下那個 server 是最小化的，你不會注意到它還在佔著 7433。
#
# 共用主控台之後，關掉視窗時 Windows 會把 CTRL_CLOSE_EVENT 送給
# 掛在這個主控台上的每一個程序 —— **兩條路都真的會結束。**
$proc = Start-Process -FilePath $node -ArgumentList @($serverEntry) `
    -WorkingDirectory $root -PassThru -NoNewWindow

# **等它真的接受連線，不是傻等固定秒數。**
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 400
    if ($proc.HasExited) {
        Stop-WithMessage 'server 啟動後隨即結束' @(
            '手動跑一次看它印了什麼：'
            "    cd $root"
            '    node dist\main.js'
        )
    }
    if ((Get-PortOwner) -eq 'cyclosa') { $ready = $true; break }
}
if (-not $ready) {
    if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Stop-WithMessage '等不到 server 回應' @("預期位置：$url", '手動跑 node dist\main.js 看看它印了什麼')
}

Write-Ok "已啟動：$url"
Start-Process $url

Write-Host ''
Write-Host '  資料存在專案外的資料根目錄 —— 第一次啟動會請你選一個位置。' -ForegroundColor DarkGray
Write-Host '  關掉這個視窗（或按 Enter）就會結束 Cyclosa。' -ForegroundColor DarkYellow
Write-Host '  下面開始是 server 自己的紀錄。' -ForegroundColor DarkGray
Write-Host ''
Read-Host '按 Enter 結束'

if (-not $proc.HasExited) {
    Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
}
