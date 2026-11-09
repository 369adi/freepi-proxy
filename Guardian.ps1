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
function Get-SponsorSlotIds() {
    $root = Join-Path $env:USERPROFILE '.free-pi\sponsor-window'
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

function Show-SponsorFor([string]$SafeId, [string]$Url, $Browser, $OpenWindows) {
    $root = Join-Path $env:USERPROFILE '.free-pi\sponsor-window'
    $profile = Join-Path $root $SafeId

    if ($OpenWindows.ContainsKey($SafeId)) {
        # Already running: never stack a second window, just make sure the
        # existing one is not minimised, otherwise free-pi pauses the account.
        $procId = [int]$OpenWindows[$SafeId]
        $hwnd = Get-MainWindowHandle $procId
        if ($hwnd -gt 0) {
            if (Test-Minimized $hwnd) {
                if (Restore-Window $hwnd) { Write-Guardian ("Sponsor window for " + $SafeId + " was minimised; restored it.") }
            }
            $slot = Get-SlotFor $SafeId
            [void](Move-WindowTo $hwnd $slot.X $slot.Y)
        }
        return $false
    }

    if (-not $Browser) { return $false }
    New-Item -ItemType Directory -Path $profile -Force | Out-Null
    # Same profile marker the proxy writes: without it Edge opens the welcome
    # tab and the sponsor card stops being the visible document.
    try { Set-Content -LiteralPath (Join-Path $profile 'First Run') -Value '' -Force } catch { }
    try {
        Start-Process -FilePath $Browser -ArgumentList @(
            ('--app=' + $Url),
            ('--user-data-dir=' + $profile),
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-sync',
            '--disable-features=EdgeSyncConfirmation,MsEdgeFirstRunExperience,EdgePromoPopup',
            '--no-service-autorun',
            '--disable-component-update',
            '--window-size=760,820'
        ) | Out-Null
        # Give the window its own place on the desktop. Edge starts every app
        # window at the same coordinates, so without this every account after
        # the first is covered by the previous one and never confirms a display.
        #
        # The window is looked up by its profile path rather than through the
        # process Start-Process returned: when a browser for that profile is
        # already running the new window belongs to the existing process, so the
        # returned id would point at the wrong window and we would move someone
        # else's.
        $slot = Get-SlotFor $SafeId
        for ($attempt = 0; $attempt -lt 10; $attempt++) {
            Start-Sleep -Milliseconds 500
            $hwnd = Get-SponsorWindowHandle $SafeId
            if ($hwnd -gt 0) {
                if (Move-WindowTo $hwnd $slot.X $slot.Y) {
                    Write-Guardian ('Placed the sponsor window for ' + $SafeId + ' at ' + $slot.X + ',' + $slot.Y + '.')
                }
                break
            }
        }
        Write-Guardian ('Opened sponsor window for ' + $SafeId)
        return $true
    } catch {
        Write-Guardian ('Could not open the sponsor window for ' + $SafeId + ': ' + $_.Exception.Message)
        return $false
    }
}

Write-Guardian ('Guardian started; checking every ' + $CheckSeconds + ' seconds.')

$lastAccounts = @()
$lastAccountRefresh = [DateTime]::MinValue
$accountRefreshEvery = 60

while ($true) {
    try {
        $alive = Test-ProxyAlive
        $watchdogPids = Get-WatchdogPids

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

        # Sponsor windows keep the account's free allowance alive. They are only
        # touched while the proxy answers, because the account list comes from it.
        if ($alive) {
            if (([DateTime]::UtcNow - $lastAccountRefresh).TotalSeconds -ge $accountRefreshEvery) {
                $lastAccountRefresh = [DateTime]::UtcNow
                $lastAccounts = Get-SponsorAccounts
                if ($lastAccounts.Count -eq 0) {
                    Write-Guardian 'Sponsor account list is empty; will retry on the next pass.'
                }
            }
            if ($lastAccounts.Count -gt 0) {
                $browser = Get-SponsorBrowser
                if (-not $browser) {
                    Write-Guardian 'No browser found for the sponsor windows.'
                } else {
                    $openWindows = Get-OpenSponsorWindows
                    foreach ($account in $lastAccounts) {
                        if (-not $account.id) { continue }
                        $safeId = ($account.id -replace '[^A-Za-z0-9_-]', '_')
                        $url = if ($account.url) { $account.url } else { $proxyBase + '/sponsor' }
                        Show-SponsorFor -SafeId $safeId -Url $url -Browser $browser -OpenWindows $openWindows
                    }
                }
            }
        }
    } catch {
        Write-Guardian ('Guardian error: ' + $_.Exception.Message)
    }
    Start-Sleep -Seconds $CheckSeconds
}
