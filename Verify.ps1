<#
.SYNOPSIS
    驗證閘門：lint、型別、測試（含 tests\guards\ 那一區）、圖表是否過期。

.DESCRIPTION
    **每個 Stage 收尾都要跑這一支，而且要全綠才算收尾。**

    它刻意**不建置** —— 建置是 Launch.ps1 的事。
    這一支只回答「現在的原始碼有沒有問題」。

.PARAMETER Report
    另外產出一份**去識別化**的環境快照到 docs\environment\snapshots\。
    只留 Node／npm 版本、OS 版本這類與人無關的事實 ——
    使用者名、機器名、絕對路徑一律換成佔位符（REQ-0008）。

.EXAMPLE
    .\Verify.ps1
    .\Verify.ps1 -Report
#>
[CmdletBinding()]
param(
    [switch]$Report
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$failures = @()

function Invoke-Check {
    param([string]$Name, [scriptblock]$Body)
    Write-Host "`n=== $Name" -ForegroundColor Cyan

    # **PowerShell 5.1 把原生指令寫到 stderr 的每一行都包成 ErrorRecord**，
    # 而 $ErrorActionPreference = 'Stop' 會讓那件事直接中斷腳本 ——
    # 即使那個指令最後回傳 0。lint 與測試工具常態性地用 stderr 印進度，
    # 所以這裡要把偏好降級，**只信 exit code**。
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $Body
    } finally {
        $ErrorActionPreference = $saved
    }

    if ($LASTEXITCODE -ne 0) {
        $script:failures += $Name
        Write-Host "  失敗  $Name" -ForegroundColor Red
    } else {
        Write-Host "  OK    $Name" -ForegroundColor Green
    }
}

Push-Location $root
try {
    if (-not (Test-Path (Join-Path $root 'node_modules'))) {
        Write-Host '  node_modules 不存在。先跑 npm ci。' -ForegroundColor Yellow
        exit 1
    }

    Invoke-Check 'eslint' { & npx eslint . }
    Invoke-Check 'prettier' { & npx prettier --check . }
    Invoke-Check '型別（server 與測試）' { & npx tsc -p tsconfig.json --noEmit }
    Invoke-Check '型別（web）' { & npx vue-tsc -p tsconfig.web.json --noEmit }
    Invoke-Check '測試（含守門）' { & npx vitest run --reporter=dot }
    Invoke-Check '兩份 agent 檔逐字相同' { & (Join-Path $root 'tools\Sync-AgentDocs.ps1') -Check }

    # 圖表過期只是提醒，不擋 —— 產圖需要網路與 npx 下載 Chromium，
    # 而驗證閘門不該依賴網路。
    Write-Host "`n=== 圖表是否過期" -ForegroundColor Cyan
    & (Join-Path $root 'tools\diagrams\Render-Diagrams.ps1') -Check
    if ($LASTEXITCODE -ne 0) {
        Write-Host '  提醒  有圖過期了，跑 .\tools\diagrams\Render-Diagrams.ps1 重新產生' -ForegroundColor Yellow
    } else {
        Write-Host '  OK    圖表都是最新的' -ForegroundColor Green
    }
} finally {
    Pop-Location
}

if ($Report) {
    Write-Host "`n=== 環境快照" -ForegroundColor Cyan
    $dir = Join-Path $root 'docs\environment\snapshots'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

    $nodeVersion = (& node --version)
    $npmVersion = (& npm --version)
    $sqlite = (& node -p "require('node:sqlite').DatabaseSync ? new (require('node:sqlite').DatabaseSync)(':memory:').prepare('select sqlite_version() v').get().v : 'n/a'")

    # **去識別化**：不寫使用者名、機器名、絕對路徑。
    # 否則公開前檢查會掃到我們自己產的檔（REQ-0008）。
    $lines = @(
        '# 環境快照'
        ''
        '**產生物。** `Verify.ps1 -Report` 產生，**已去識別化** ——'
        '沒有使用者名、機器名或絕對路徑，只留與人無關的事實。'
        ''
        "| | |"
        "|---|---|"
        "| 產生日期 | $(Get-Date -Format 'yyyy-MM-dd') |"
        "| OS | $([System.Environment]::OSVersion.VersionString) |"
        "| 架構 | $env:PROCESSOR_ARCHITECTURE |"
        "| 邏輯核心數 | $([System.Environment]::ProcessorCount) |"
        "| Node | $nodeVersion |"
        "| npm | $npmVersion |"
        "| node:sqlite 的 SQLite | $sqlite |"
        "| PowerShell | $($PSVersionTable.PSVersion) |"
        ''
        '> **效能數字不在這裡**，在 `docs/environment/performance.md` ——'
        '> 它們要連同量測條件一起讀（語料的形狀、從哪一個節點、查哪一個詞、'
        '> 重複幾次）。**沒有量測條件的數字不能拿來做決定。**'
        '>'
        '> 這一份是機器事實，每次 `-Report` 重新產生；那一份是手寫的量測報告。'
        '> **兩者不要合併** —— 合併之後下一次 `-Report` 會把報告蓋掉。'
        ''
    )
    $path = Join-Path $dir "$(Get-Date -Format 'yyyy-MM-dd').md"
    # .md 一律 UTF-8 **無 BOM**（CONVENTIONS §8）
    [System.IO.File]::WriteAllText($path, ($lines -join "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "  OK    寫出 docs\environment\snapshots\$(Split-Path $path -Leaf)" -ForegroundColor Green
}

Write-Host ''
if ($failures.Count -gt 0) {
    Write-Host "有 $($failures.Count) 項失敗：" -ForegroundColor Red
    foreach ($f in $failures) { Write-Host "  · $f" -ForegroundColor Red }
    exit 1
}
Write-Host '全部通過。' -ForegroundColor Green
exit 0
