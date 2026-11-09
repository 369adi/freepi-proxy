param([string]$ProxyDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$proxyDirectory = (Resolve-Path -LiteralPath $ProxyDirectory).Path
$proxyNode = (Get-Command node.exe -ErrorAction Stop).Source
$proxyLogs = Join-Path $proxyDirectory 'logs'
New-Item -ItemType Directory -Path $proxyLogs -Force | Out-Null
$proxyWatchLog = Join-Path $proxyLogs 'watchdog.log'
$proxyPidFile = Join-Path $proxyLogs 'proxy.pid'
$proxyChild = $null
$sponsorOpened = $false

function Show-ProxySponsor {
    if (-not $script:sponsorOpened) {
        try {
            & (Join-Path $proxyDirectory 'Show-Sponsor.ps1')
            $script:sponsorOpened = $true
        } catch { Write-ProxyEvent ('Open http://127.0.0.1:4000/sponsor to display ads. ' + $_.Exception.Message) }
    }
}

function Write-ProxyEvent([string]$Message) {
    if ((Test-Path -LiteralPath $proxyWatchLog) -and (Get-Item -LiteralPath $proxyWatchLog).Length -gt 5MB) {
        Move-Item -LiteralPath $proxyWatchLog -Destination ($proxyWatchLog + '.previous') -Force
    }
    Add-Content -LiteralPath $proxyWatchLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message)
}

Write-ProxyEvent 'Supervisor started.'
try {
    while ($true) {
        $proxyChild = $null
        try {
            # Another foreground start may already own the endpoint. Monitor it without spawning duplicates.
            try {
                $proxyExisting = Invoke-RestMethod -Uri 'http://127.0.0.1:4000/v1/models' -TimeoutSec 3
                if ($proxyExisting.object -eq 'list') {
                    Show-ProxySponsor
                    Write-ProxyEvent 'An existing proxy owns port 4000; monitoring it without starting a duplicate.'
                    do {
                        Start-Sleep -Seconds 5
                        $proxyExisting = Invoke-RestMethod -Uri 'http://127.0.0.1:4000/v1/models' -TimeoutSec 3
                    } while ($proxyExisting.object -eq 'list')
                }
            } catch { }
            foreach ($proxyLogName in @('proxy.stdout.log', 'proxy.stderr.log')) {
                $proxyLogPath = Join-Path $proxyLogs $proxyLogName
                if ((Test-Path -LiteralPath $proxyLogPath) -and (Get-Item -LiteralPath $proxyLogPath).Length -gt 10MB) {
                    Move-Item -LiteralPath $proxyLogPath -Destination ($proxyLogPath + '.previous') -Force
                }
            }
            $proxyChild = Start-Process -FilePath $proxyNode -ArgumentList 'proxy.mjs' -WorkingDirectory $proxyDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $proxyLogs 'proxy.stdout.log') -RedirectStandardError (Join-Path $proxyLogs 'proxy.stderr.log')
            Set-Content -LiteralPath $proxyPidFile -Value $proxyChild.Id -Encoding Ascii
            Write-ProxyEvent ('Proxy started; PID ' + $proxyChild.Id)
            $proxyStarted = [DateTime]::UtcNow
            $proxyLastHealthy = $null
            $proxyNextCheck = [DateTime]::UtcNow.AddSeconds(3)
            while (-not $proxyChild.WaitForExit(1000)) {
                if ([DateTime]::UtcNow -lt $proxyNextCheck) { continue }
                $proxyNextCheck = [DateTime]::UtcNow.AddSeconds(10)
                try {
                    $proxyHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:4000/v1/models' -TimeoutSec 4
                    if ($proxyHealth.object -ne 'list') { throw 'Unexpected model response' }
                    Show-ProxySponsor
                    if ($null -eq $proxyLastHealthy) { Write-ProxyEvent 'Local API is healthy.' }
                    $proxyLastHealthy = [DateTime]::UtcNow
                } catch {
                    $proxyHealthReference = if ($null -eq $proxyLastHealthy) { $proxyStarted } else { $proxyLastHealthy }
                    if (([DateTime]::UtcNow - $proxyHealthReference).TotalSeconds -gt 45) {
                        Write-ProxyEvent 'Local API did not respond for 45 seconds; restarting this proxy process.'
                        Stop-Process -Id $proxyChild.Id -Force -ErrorAction SilentlyContinue
                        $proxyChild.WaitForExit()
                    }
                }
            }
            Write-ProxyEvent ('Proxy exited; exit code ' + $proxyChild.ExitCode + '. Restarting in 3 seconds.')
        } catch {
            Write-ProxyEvent ('Supervisor error: ' + $_.Exception.Message + '. Retrying in 3 seconds.')
        } finally {
            if ($null -ne $proxyChild) {
                if (-not $proxyChild.HasExited) { Stop-Process -Id $proxyChild.Id -Force -ErrorAction SilentlyContinue }
                $proxyChild.Dispose()
            }
        }
        Start-Sleep -Seconds 3
    }
} finally {
    if ($null -ne $proxyChild -and -not $proxyChild.HasExited) { Stop-Process -Id $proxyChild.Id -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $proxyPidFile -Force -ErrorAction SilentlyContinue
}
