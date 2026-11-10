param(
    [string]$ProxyDirectory = $PSScriptRoot,
    [int]$CheckSeconds = 20
)

# Guardian: single-instance headless supervisor for Free-Pi Proxy.
$createdNew = $false
$guardianMutex = New-Object System.Threading.Mutex($true, 'Local\FreePiGuardianMutex', [ref]$createdNew)
if (-not $createdNew) {
    exit 0
}

$ErrorActionPreference = 'Continue'
$proxyDirectory = (Resolve-Path -LiteralPath $ProxyDirectory).Path
$guardianLogs = Join-Path $proxyDirectory 'logs'
New-Item -ItemType Directory -Path $guardianLogs -Force | Out-Null
$guardianLog = Join-Path $guardianLogs 'guardian.log'
$proxyBase = 'http://127.0.0.1:4000'

function Write-Guardian([string]$Message) {
    if ((Test-Path -LiteralPath $guardianLog) -and (Get-Item -LiteralPath $guardianLog).Length -gt 5MB) {
        Move-Item -LiteralPath $guardianLog -Destination ($guardianLog + '.previous') -Force
    }
    Add-Content -LiteralPath $guardianLog -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $Message)
}

function Test-ProxyAlive {
    try {
        $h = Invoke-RestMethod -Uri ($proxyBase + '/health') -TimeoutSec 8
        return ($h.status -eq 'ok')
    } catch {
        try {
            $m = Invoke-RestMethod -Uri ($proxyBase + '/v1/models') -TimeoutSec 8
            return ($m.object -eq 'list')
        } catch { return $false }
    }
}

function Get-WatchdogPids {
    $all = @()
    foreach ($proc in (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue)) {
        if ($proc.CommandLine -and $proc.CommandLine -match 'Watch-Proxy\.ps1' -and $proc.CommandLine -notmatch 'Guardian\.ps1') {
            $all += $proc.ProcessId
        }
    }
    return $all
}

function Start-Watchdog {
    $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $watch = Join-Path $proxyDirectory 'Watch-Proxy.ps1'
    if (-not (Test-Path -LiteralPath $watch)) { Write-Guardian 'Watch-Proxy.ps1 missing; cannot start the supervisor.'; return }
    Start-Process -FilePath $ps -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden', '-File', $watch
    ) -WindowStyle Hidden
    Write-Guardian 'Watchdog was missing; started a new supervisor.'
}

function Get-HarnessWatcherPids {
    $all = @()
    foreach ($proc in (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue)) {
        if ($proc.CommandLine -and $proc.CommandLine -match 'Watch-Harness\.ps1') {
            $all += $proc.ProcessId
        }
    }
    return $all
}

function Start-HarnessWatcher {
    $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $watch = Join-Path $proxyDirectory 'Watch-Harness.ps1'
    if (-not (Test-Path -LiteralPath $watch)) { return }
    Start-Process -FilePath $ps -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden', '-File', $watch
    ) -WindowStyle Hidden
    Write-Guardian 'DSH reconnect watcher was missing; started it.'
}

function Start-HeadlessSponsorIfMissing {
    $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'headless-sponsor\.mjs' -and $_.CommandLine -notmatch '--once' })
    if ($running.Count -gt 0) { return }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $script = Join-Path $proxyDirectory 'tools\headless-sponsor.mjs'
    if (-not (Test-Path -LiteralPath $script)) { return }
    $outLog = Join-Path $guardianLogs 'headless-sponsor.stdout.log'
    $errLog = Join-Path $guardianLogs 'headless-sponsor.stderr.log'
    Start-Process -FilePath $node -ArgumentList @($script, '--interval', '45000') -WorkingDirectory $proxyDirectory -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
    Write-Guardian 'Started headless sponsor daemon (tools/headless-sponsor.mjs).'
}

Write-Guardian ('Guardian started; checking every ' + $CheckSeconds + ' seconds.')

try {
    while ($true) {
        try {
            $alive = Test-ProxyAlive
            $watchdogPids = Get-WatchdogPids
            if ((Get-HarnessWatcherPids).Count -eq 0) { Start-HarnessWatcher }
            Start-HeadlessSponsorIfMissing

            if (-not $alive) {
                Write-Guardian 'Proxy is not answering; starting the supervisor to bring it back.'
                if ($watchdogPids.Count -eq 0) {
                    Start-Watchdog
                } else {
                    Start-Sleep -Seconds 10
                    if (-not (Test-ProxyAlive) -and (Get-WatchdogPids).Count -eq 0) { Start-Watchdog }
                }
            } elseif ($watchdogPids.Count -eq 0) {
                Write-Guardian 'Proxy is healthy but no supervisor is running; starting one.'
                Start-Watchdog
            }
        } catch {
            Write-Guardian ('Guardian error: ' + $_.Exception.Message)
        }
        Start-Sleep -Seconds $CheckSeconds
    }
} finally {
    $guardianMutex.ReleaseMutex()
    $guardianMutex.Dispose()
}
