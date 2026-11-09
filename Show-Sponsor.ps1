$ErrorActionPreference = 'Stop'
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
    $profile = Join-Path $sponsorRoot $safeId
    $address = if ($account.url) { $account.url } else { $proxyBase + '/sponsor' }

    # Already open for this account? Leave it alone instead of stacking windows.
    $running = Get-CimInstance Win32_Process |
        Where-Object { $_.Name -in @('msedge.exe', 'chrome.exe', 'brave.exe') -and $_.CommandLine -like ('*' + $profile + '*') -and $_.CommandLine -like '*--app=*' }
    if ($running) { continue }

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
    $opened++
    Write-Host ('sponsor window opened for ' + $account.id + ($(if ($account.handle) { ' (@' + $account.handle + ')' } else { '' })))
    Start-Sleep -Milliseconds 500
}

if ($opened -eq 0) {
    Write-Host 'All sponsor windows are already open - keep them visible.'
} else {
    Write-Host ('Opened ' + $opened + ' sponsor window(s). Keep them visible so ads can be confirmed.')
}
