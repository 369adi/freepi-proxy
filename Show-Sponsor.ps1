param([string]$AccountId, [switch]$Migrate)
$ErrorActionPreference = 'Stop'
$sponsorMutex = New-Object System.Threading.Mutex($false, 'Local\FreePiSponsorWindows')
$sponsorMutexHeld = $false
try {
try { $sponsorMutexHeld = $sponsorMutex.WaitOne(2000) } catch [System.Threading.AbandonedMutexException] { $sponsorMutexHeld = $true }
if (-not $sponsorMutexHeld) { Write-Host 'Sponsor windows are already being checked.'; exit 0 }
$proxyBase = 'http://127.0.0.1:4000'
$sponsorRoot = Join-Path $env:USERPROFILE '.free-pi\sponsor-window'

for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { $null = Invoke-RestMethod ($proxyBase + '/v1/models') -TimeoutSec 2; break } catch { Start-Sleep -Seconds 1 }
}

# /sponsor/accounts sits behind the panel cookie, so open a session first. The
# cookie is only used to read the list - the browser windows establish their own.
$session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
try {
    $null = Invoke-WebRequest ($proxyBase + '/sponsor') -WebSession $session -UseBasicParsing -TimeoutSec 5
    $list = (Invoke-RestMethod ($proxyBase + '/sponsor/accounts') -WebSession $session -TimeoutSec 5).accounts
} catch {
    $list = @()
}
if (-not $list -or $list.Count -eq 0) {
    # No account list means the proxy cannot say which accounts exist. Opening a
    # single window under a made-up 'active' profile would create a profile that
    # belongs to no account, so say so instead of inventing one.
    Write-Host 'The proxy did not report any accounts. Nothing to open.'
    exit 1
}
$sharedProfile = Join-Path $sponsorRoot 'shared'
$registryFile = Join-Path $sponsorRoot 'browser-windows.json'
function Get-SharedSponsorBrowser {
    Get-CimInstance Win32_Process | Where-Object {
        $_.Name -in @('msedge.exe','chrome.exe','brave.exe') -and
        $_.CommandLine -notmatch '--type=' -and
        $_.CommandLine -match [regex]::Escape($sharedProfile)
    } | Select-Object -First 1
}
function Get-BrowserKey($BrowserProcess) {
    if (-not $BrowserProcess) { return '' }
    return ('{0}:{1}' -f $BrowserProcess.ProcessId, $BrowserProcess.CreationDate.ToUniversalTime().Ticks)
}
function Save-WindowRegistry {
    $registry | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath ($registryFile + '.tmp') -Encoding UTF8
    Move-Item -LiteralPath ($registryFile + '.tmp') -Destination $registryFile -Force
}
$existingBrowser = Get-SharedSponsorBrowser
$browserKey = Get-BrowserKey $existingBrowser
$registry = $null
try { $registry = Get-Content -LiteralPath $registryFile -Raw | ConvertFrom-Json } catch { }
if (-not $registry -or $registry.browserKey -ne $browserKey) {
    # Adopt the already-open six-window browser at installation. A new browser
    # generation starts empty; every account is then opened exactly once.
    $adopt = $existingBrowser -and -not (Test-Path -LiteralPath $registryFile)
    $registry = [pscustomobject]@{ browserKey=$browserKey; accounts=@(); }
    if ($adopt) { $registry.accounts = @($list | ForEach-Object { $_.id }) }
    Save-WindowRegistry
}
# A registry entry proves a launch was attempted, not that its page is alive.
# Trust recent heartbeats or actual display confirmations, with a grace period
# for background-throttled windows and a rate limit before reopening.
$liveAccounts = $null
try { $liveAccounts = (Invoke-RestMethod ($proxyBase + '/sponsor/windows') -WebSession $session -TimeoutSec 5).accounts } catch { }
if ($AccountId) { $list = @($list | Where-Object id -eq $AccountId) }

$sponsorBrowser = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $sponsorBrowser) { throw 'Install Edge or Chrome, or open ' + $proxyBase + '/sponsor in your browser.' }

# One desktop slot per account, same rule the guardian uses: a window that is
# covered by the previous account's window never counts as visible.
$slotIds = @()
if (Test-Path $sponsorRoot) {
    $slotIds = @(Get-ChildItem -Path $sponsorRoot -Directory |
        Where-Object { $_.Name -match '^acc-[0-9]+$' } |
        Select-Object -ExpandProperty Name)
}
$slotIds = @($slotIds | Sort-Object { [int]($_ -replace '^acc-', '') })

$opened = 0
foreach ($account in $list) {
    $safeId = ($account.id -replace '[^A-Za-z0-9_-]', '_')
    $profile = Join-Path $sponsorRoot 'shared'
    $address = if ($account.url) { $account.url } else { $proxyBase + '/sponsor' }

    $stamp = Join-Path $sponsorRoot ($safeId + '.launch')
    $live = $liveAccounts -and $liveAccounts.PSObject.Properties[$account.id] -and $liveAccounts.($account.id)
    $displayRecent = $false
    try { if ($account.lastDisplay.at) { $displayRecent = ([DateTime]::UtcNow - [DateTime]::Parse($account.lastDisplay.at).ToUniversalTime()).TotalMinutes -lt 5 } } catch { }
    $recentLaunch = (Test-Path -LiteralPath $stamp) -and (([DateTime]::UtcNow - (Get-Item -LiteralPath $stamp).LastWriteTimeUtc).TotalMinutes -lt 5)
    # If the live endpoint cannot be read, avoid spawning duplicates blindly.
    if ($existingBrowser -and ($live -or $displayRecent -or $recentLaunch -or ($null -eq $liveAccounts -and $registry.accounts -contains $account.id))) {
        Write-Host ('Already open or recently active: ' + $account.id)
        continue
    }

    $index = [array]::IndexOf($slotIds, $safeId)
    if ($index -lt 0) { $index = $slotIds.Count }
    $offset = $index * 44

    New-Item -ItemType Directory -Path $profile -Force | Out-Null
    try { Set-Content -LiteralPath (Join-Path $profile 'First Run') -Value '' -Force } catch { }
    Start-Process -FilePath $sponsorBrowser -ArgumentList @(
        '--app=' + $address,
        '--user-data-dir=' + $profile,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-sync',
        '--disable-features=EdgeSyncConfirmation,MsEdgeFirstRunExperience,EdgePromoPopup',
        '--no-service-autorun',
        '--disable-component-update',
        '--window-size=760,820',
        ('--window-position=' + (30 + $offset) + ',' + (30 + $offset))
    ) -WindowStyle Normal
    for ($wait = 0; $wait -lt 10; $wait++) {
        $existingBrowser = Get-SharedSponsorBrowser
        if ($existingBrowser) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $existingBrowser) { throw 'Sponsor browser did not start; no window was marked as opened.' }
    $registry.browserKey = Get-BrowserKey $existingBrowser
    $registry.accounts = @(@($registry.accounts) + $account.id | Select-Object -Unique)
    Save-WindowRegistry
    Set-Content -LiteralPath $stamp -Value ([DateTime]::UtcNow.ToString('o')) -Encoding Ascii
    $opened++
    Write-Host ('sponsor window opened for ' + $account.id + ($(if ($account.handle) { ' (@' + $account.handle + ')' } else { '' })))
    Start-Sleep -Milliseconds 500
}

if ($opened -eq 0) {
    Write-Host 'All sponsor windows are already open - keep them visible.'
} else {
    Write-Host ('Opened ' + $opened + ' sponsor window(s). Keep them visible so ads can be confirmed.')
}
} finally {
    if ($sponsorMutexHeld) { $sponsorMutex.ReleaseMutex() }
    $sponsorMutex.Dispose()
}



