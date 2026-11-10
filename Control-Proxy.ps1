param([ValidateSet('start', 'restart')][string]$Action = 'start')
$ErrorActionPreference = 'Stop'
$taskName = 'FreePi Proxy'
$proxyAddress = 'http://127.0.0.1:4000'

function Test-ProxyReady {
    try {
        $health = Invoke-RestMethod ($proxyAddress + '/v1/models') -TimeoutSec 2
        return $health.object -eq 'list'
    } catch { return $false }
}

try {
    if ($Action -eq 'restart') {
        # Stop supervision first, then only this project's verified Node process.
        Stop-ScheduledTask -TaskName $taskName
        $pidFile = Join-Path $PSScriptRoot 'logs\proxy.pid'
        $ownedProcessId = if (Test-Path -LiteralPath $pidFile) { [int](Get-Content -LiteralPath $pidFile) } else { 0 }
        $listener = Get-NetTCPConnection -State Listen -LocalPort 4000 -ErrorAction SilentlyContinue
        $candidateIds = @($ownedProcessId) + @($listener | Select-Object -ExpandProperty OwningProcess)
        foreach ($candidateId in ($candidateIds | Where-Object { $_ -gt 0 } | Select-Object -Unique)) {
            $candidate = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $candidateId)
            if ($null -eq $candidate) { continue }
            $sameDirectory = $candidate.CommandLine -match [regex]::Escape((Join-Path $PSScriptRoot 'proxy.mjs'))
            $ownedRelative = $candidateId -eq $ownedProcessId -and $candidate.CommandLine -match '(?:^|\s)"?proxy\.mjs"?(?:\s|$)'
            if ($candidate.Name -eq 'node.exe' -and ($sameDirectory -or $ownedRelative)) {
                Stop-Process -Id $candidateId -Force -ErrorAction SilentlyContinue
                Wait-Process -Id $candidateId -Timeout 5 -ErrorAction SilentlyContinue
            } elseif ($listener.OwningProcess -contains $candidateId) {
                throw 'Port 4000 belongs to an unrecognized process; it was not stopped.'
            }
        }
        Start-Sleep -Seconds 1
    }
    # Starting is idempotent and also restores supervision of an existing proxy.
    Start-ScheduledTask -TaskName $taskName
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    do {
        if (Test-ProxyReady) {
            Write-Output ('Proxy ready: ' + $proxyAddress + '/v1 (' + $Action + '). Supervisor enabled.')
            exit 0
        }
        Start-Sleep -Seconds 1
    } while ([DateTime]::UtcNow -lt $deadline)
    throw ('Proxy did not become ready within 45 seconds. Check ' + (Join-Path $PSScriptRoot 'logs'))
} catch {
    Write-Output ('Proxy ' + $Action + ' failed: ' + $_.Exception.Message)
    exit 1
}
