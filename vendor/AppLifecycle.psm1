function Get-AppLifecycleHealthz {
    [CmdletBinding()]
    param([Parameter(Mandatory)][uri]$Uri, [ValidateRange(1, 30)][int]$TimeoutSeconds = 2)

    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec $TimeoutSeconds
        $body = $null
        try { $body = $response.Content | ConvertFrom-Json } catch { }
        return [pscustomobject]@{ Reachable = $true; StatusCode = [int]$response.StatusCode; Body = $body }
    } catch {
        $statusCode = $null
        $body = $null
        $response = $_.Exception.Response
        if ($null -ne $response) {
            try { $statusCode = [int]$response.StatusCode } catch { }
            try {
                $stream = $response.GetResponseStream()
                if ($null -ne $stream) {
                    $reader = New-Object System.IO.StreamReader($stream)
                    try { $body = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
                }
            } catch { }
        }
        return [pscustomobject]@{ Reachable = ($null -ne $statusCode); StatusCode = $statusCode; Body = $body }
    }
}

Export-ModuleMember -Function Get-AppLifecycleHealthz
