<#
.SYNOPSIS
    用 CLAUDE.md 的本文重新產生 AGENTS.md，只保留各自的互指聲明。

.DESCRIPTION
    **ADR-0013 的代價那一節寫著「產生器目前不在 repo 裡，所以現在保證平級的是
    驗證器，不是產生流程」。這支腳本就是把那一步補上。**

    兩份 agent 檔是平級的全文，內容必須逐字相同 —— 差異只有
    `<!-- agent-doc:sync-notice -->` 這對標記之間的那一段（標題與互指聲明）。

    治理層的 `agent-doc-content-drift` 檢查會剝掉那對標記再比 hash。
    **那條檢查是 opt-in 的**：沒有標記它根本不會啟動，所以標記本身不能弄丟。

    做法刻意是「以 CLAUDE.md 為來源」而不是「另外放一份本文」：
    多一份本文就多一個會漂的東西，而且那一份沒有任何工具會自動載入它，
    所以沒有人會發現它舊了。

.PARAMETER Check
    只比對、不寫檔。不一致時 exit 1 —— 給驗證閘門用。

.EXAMPLE
    .\tools\Sync-AgentDocs.ps1
    .\tools\Sync-AgentDocs.ps1 -Check
#>
[CmdletBinding()]
param(
    [switch]$Check
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$claudePath = Join-Path $root 'CLAUDE.md'
$agentsPath = Join-Path $root 'AGENTS.md'

$openTag = '<!-- agent-doc:sync-notice -->'
$closeTag = '<!-- /agent-doc:sync-notice -->'

function Split-Doc {
    param([string]$Path)

    # **一律用 ReadAllText 而不是 Get-Content -Raw。**
    # PS 5.1 的 Get-Content 預設用系統 ANSI codepage（這台機器是 Big5），
    # UTF-8 的中文會被讀壞 —— docs\lessons.md 記過這個坑。
    $text = [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))

    $start = $text.IndexOf($openTag)
    $end = $text.IndexOf($closeTag)
    if ($start -lt 0 -or $end -lt 0) {
        throw "$Path 裡找不到 $openTag …… $closeTag 這對標記。少了它，agent-doc-content-drift 這條檢查對這個專案是關的。"
    }
    if ($end -lt $start) {
        throw "$Path 的標記順序反了"
    }

    $notice = $text.Substring($start, $end - $start + $closeTag.Length)
    $body = $text.Substring($end + $closeTag.Length)
    return @{ Notice = $notice; Body = $body }
}

$claude = Split-Doc -Path $claudePath
$agents = Split-Doc -Path $agentsPath

# AGENTS.md ＝ 它自己的互指聲明 ＋ CLAUDE.md 的本文
$expected = $agents.Notice + $claude.Body

$current = [System.IO.File]::ReadAllText($agentsPath, [System.Text.UTF8Encoding]::new($false))

if ($current -ceq $expected) {
    Write-Host '  OK    兩份 agent 檔的本文逐字相同' -ForegroundColor Green
    exit 0
}

if ($Check) {
    Write-Host '  失敗  AGENTS.md 的本文與 CLAUDE.md 不同' -ForegroundColor Red
    Write-Host '        跑 .\tools\Sync-AgentDocs.ps1 重新產生' -ForegroundColor Yellow
    exit 1
}

# **寫檔一律 UTF-8 無 BOM**（CONVENTIONS §8：.md 不要 BOM、.ps1 才要）
[System.IO.File]::WriteAllText($agentsPath, $expected, [System.Text.UTF8Encoding]::new($false))
Write-Host '  更新  AGENTS.md（本文取自 CLAUDE.md，互指聲明保留原本的）' -ForegroundColor Cyan
