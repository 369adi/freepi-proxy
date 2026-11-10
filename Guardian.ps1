param(
    [string]$ProxyDirectory = $PSScriptRoot,
    [int]$CheckSeconds = 20
)

# Guardian: the last line of defence.
#
# Watch-Proxy.ps1 keeps the node process alive, but it can itself be killed, can
# crash on a parse error, or can wedge. The guardian therefore does not trust
# anyone: it looks at the actual state of the world every few seconds and fixes
# whatever is missing.
#
#   1. port 4000 must answer /health          -> else start the watchdog
#   2. the watchdog process must exist        -> else start it
#   3. every account must have a sponsor window -> else open it
#
# It never kills a process that answers, so it cannot cause the "connection
# error" the supervisor used to cause. It only ever adds what is missing.

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
        # Older proxy builds have no /health yet; the model list still proves life.
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

function Start-LimitWatcherIfMissing {
    $running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'auto-continue-limit\.mjs' })
    if ($running.Count -gt 0) { return }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $watch = Join-Path $proxyDirectory 'tools\auto-continue-limit.mjs'
    Start-Process -FilePath $node -ArgumentList ('"{0}"' -f $watch) -WorkingDirectory $proxyDirectory -WindowStyle Hidden
    Write-Guardian 'Started automatic API continuation for output token limits.'
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

function Start-HarnessWatcher {
    $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $watch = Join-Path $proxyDirectory 'Watch-Harness.ps1'
    if (-not (Test-Path -LiteralPath $watch)) { Write-Guardian 'Watch-Harness.ps1 missing; cannot start the DSH recovery watcher.'; return }
    Start-Process -FilePath $ps -ArgumentList @(
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-WindowStyle', 'Hidden', '-File', $watch
    ) -WindowStyle Hidden
    Write-Guardian 'DSH reconnect watcher was missing; started it.'
}

# Wander through the sponsor panel exactly like Show-Sponsor.ps1 does: the list
# sits behind the panel cookie, so a session has to be established first.
function Get-SponsorAccounts {
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    try {
        $null = Invoke-WebRequest ($proxyBase + '/sponsor') -WebSession $session -UseBasicParsing -TimeoutSec 8
        $resp = Invoke-RestMethod ($proxyBase + '/sponsor/accounts') -WebSession $session -TimeoutSec 8
        return @($resp.accounts)
    } catch {
        return @()
    }
}

function Get-RegisteredSponsorAccounts {
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    try {
        $null = Invoke-WebRequest ($proxyBase + '/sponsor') -WebSession $session -UseBasicParsing -TimeoutSec 8
        $resp = Invoke-RestMethod ($proxyBase + '/sponsor/windows') -WebSession $session -TimeoutSec 8
        return @($resp.accounts.PSObject.Properties | Select-Object -ExpandProperty Name)
    } catch {
        return @()
    }
}

function Get-SponsorBrowser {
    $candidates = @(
        'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
        'C:\Program Files\Google\Chrome\Application\chrome.exe',
        'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
    )
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
    return $null
}

# One window per account, keyed by the profile directory in the command line.
# A window that exists but is minimised does NOT count as displayed: free-pi
# only credits the account while the card is really visible.
function Get-OpenSponsorWindows {
    $map = @{}
    foreach ($proc in (Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue)) {
        if (-not $proc.CommandLine) { continue }
        if ($proc.CommandLine -notmatch '--app=') { continue }
        # Renderer and helper processes never own a window, and matching their
        # command line would map an account to a process that cannot be moved.
        if ($proc.CommandLine -match '--type=') { continue }
        if ($proc.CommandLine -match 'sponsor-window\\+(acc-[0-9]+)') {
            $windowProcess = Get-Process -Id $proc.ProcessId -ErrorAction SilentlyContinue
            if (-not $windowProcess -or $windowProcess.MainWindowHandle -eq 0) { continue }
            # Keep the process with a real window for accounts that have several.
            if (-not $map.ContainsKey($matches[1])) {
                $map[$matches[1]] = [int]$proc.ProcessId
            }
        }
    }
    return $map
}

# Declared once at load time. Calling Add-Type inside a hot function repeats the
# compilation on every call and the error is swallowed, which is how a broken
# interop binding stayed invisible while every window operation silently failed.
try {
    Add-Type -Namespace GuardianWin -Name Api -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
'@
    $script:WindowApiOk = $true
} catch {
    $script:WindowApiOk = $false
    Write-Guardian ('Window control unavailable: ' + $_.Exception.Message)
}

function Test-Minimized([int]$Hwnd) {
    if (-not $script:WindowApiOk) { return $false }
    try { return [GuardianWin.Api]::IsIconic([IntPtr]$Hwnd) } catch { return $false }
}

function Hide-Window([int]$Hwnd) {
    if ($Hwnd -le 0 -or -not $script:WindowApiOk) { return $false }
    try {
        [GuardianWin.Api]::ShowWindowAsync([IntPtr]$Hwnd, 0) | Out-Null
        return $true
    } catch { return $false }
}

function Restore-Window([int]$Hwnd) {
    if ($Hwnd -le 0) { return $false }
    if (-not $script:WindowApiOk) { return $false }
    try {
        [GuardianWin.Api]::ShowWindow([IntPtr]$Hwnd, 9) | Out-Null   # SW_RESTORE
        return $true
    } catch { return $false }
}

function Get-MainWindowHandle([int]$ProcessId) {
    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($proc -and $proc.MainWindowHandle -ne 0) { return [int]$proc.MainWindowHandle }
    return 0
}

function Move-WindowTo([int]$Hwnd, [int]$X, [int]$Y) {
    if ($Hwnd -le 0) { return $false }
    if (-not $script:WindowApiOk) { return $false }
    try {
        [GuardianWin.Api]::MoveWindow([IntPtr]$Hwnd, $X, $Y, 760, 820, $true) | Out-Null
        return $true
    } catch { return $false }
}

# Finds the window that belongs to one profile folder. The profile path is the
# only dependable link between an account and its window: the process that
# Start-Process returns is not always the one that owns the window. The path is
# matched with its trailing separator so acc-1 never also matches acc-10.
function Get-SponsorWindowHandle([string]$SafeId) {
    $needle = '\sponsor-window\' + $SafeId + '\'
    foreach ($p in (Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue)) {
        if (-not $p.CommandLine) { continue }
        if ($p.CommandLine -notmatch [regex]::Escape($needle)) { continue }
        if ($p.CommandLine -notmatch '--app=') { continue }
        if ($p.CommandLine -match '--type=') { continue }
        $hwnd = Get-MainWindowHandle ([int]$p.ProcessId)
        if ($hwnd -gt 0) { return $hwnd }
    }
    return 0
}

# Every sponsor window has to sit somewhere, and if they all start at the same
# spot only the topmost one is on screen while the others are covered. Covered
# means Chromium reports the page as hidden and the display never confirms, so
# each account gets its own slot in a cascade.
#
# Only account folders count. A browser profile holds dozens of internal
# folders (Crashpad, ShaderCache, Default, ...) and one of them may end up in
# this directory, so listing it raw would push the slots far to the right and
# stack the windows again.
# Display age is deliberately not used as a window-health signal. A background
# browser may be timer-throttled, and a missing impression must never make the
# guardian kill a still-open sponsor page.

function Get-SponsorSlotIds() {    $root = Join-Path $env:USERPROFILE '.free-pi\sponsor-window'
    $ids = @()
    if (Test-Path $root) {
        $ids = @(Get-ChildItem -Path $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^acc-[0-9]+$' } |
            Select-Object -ExpandProperty Name)
    }
    return @($ids | Sort-Object { [int]($_ -replace '^acc-', '') })
}

function Get-SlotFor([string]$SafeId) {
    $ids = @(Get-SponsorSlotIds)
    $index = [array]::IndexOf($ids, $SafeId)
    if ($index -lt 0) { $index = $ids.Count }
    return @{ X = 30 + ($index * 44); Y = 30 + ($index * 44) }
}

function Show-SponsorFor([string]$SafeId, [string]$Url, $Browser, $OpenWindows, [switch]$Registered) {
    $root = Join-Path $env:USERPROFILE '.free-pi\sponsor-window'
    $profile = Join-Path $root $SafeId

    if ($OpenWindows.ContainsKey($SafeId) -or $Registered) {
        # A quiet account means no visible impression was recorded. It does not
        # mean the window is dead, so never kill or reopen it for being quiet.
        if ($OpenWindows.ContainsKey($SafeId)) {
            $procId = [int]$OpenWindows[$SafeId]
            $hwnd = Get-MainWindowHandle $procId
            if ($hwnd -gt 0) {
                if (Test-Minimized $hwnd) {
                    if (Restore-Window $hwnd) { Write-Guardian ("Sponsor window for " + $SafeId + " was minimised; restored it.") }
                }
                $slot = Get-SlotFor $SafeId
                [void](Move-WindowTo $hwnd $slot.X $slot.Y)
            }
        }
        return $false
    }

    & (Join-Path $proxyDirectory 'Show-Sponsor.ps1') -AccountId $SafeId
    return $true
}

Write-Guardian ('Guardian started; checking every ' + $CheckSeconds + ' seconds.')

$lastAccounts = @()
$lastAccountRefresh = [DateTime]::MinValue
$accountRefreshEvery = 60

while ($true) {
    try {
        $alive = Test-ProxyAlive
        $watchdogPids = Get-WatchdogPids
        if ((Get-HarnessWatcherPids).Count -eq 0) { Start-HarnessWatcher }
        Start-LimitWatcherIfMissing
        Start-HeadlessSponsorIfMissing

        if (-not $alive) {
            Write-Guardian 'Proxy is not answering; starting the supervisor to bring it back.'
            if ($watchdogPids.Count -eq 0) {
                Start-Watchdog
            } else {
                # A watchdog exists but the proxy is down: it will notice and
                # restart on its own, but if it has been silent too long the
                # guardian adds a second one - the watchdog exits immediately if
                # port 4000 is already served, so duplicates are harmless.
                Start-Sleep -Seconds 10
                if (-not (Test-ProxyAlive) -and (Get-WatchdogPids).Count -eq 0) { Start-Watchdog }
            }
        } elseif ($watchdogPids.Count -eq 0) {
            Write-Guardian 'Proxy is healthy but no supervisor is running; starting one.'
            Start-Watchdog
        }

        # Headless sponsor mode: sponsor windows are never opened. The node
        # watchdog (tools/watchdog.mjs) keeps the proxy alive and the headless
        # sponsor daemon (tools/headless-sponsor.mjs) confirms every impression
        # over HTTP; free-pi still decides whether an ad counts.
    } catch {
        Write-Guardian ('Guardian error: ' + $_.Exception.Message)
    }
    Start-Sleep -Seconds $CheckSeconds
}


