$ErrorActionPreference = 'Stop'
$sponsorAddress = 'http://127.0.0.1:4000/sponsor'
$sponsorProfile = Join-Path $env:USERPROFILE '.free-pi\sponsor-window'
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    try { $null = Invoke-RestMethod 'http://127.0.0.1:4000/v1/models' -TimeoutSec 2; break } catch { Start-Sleep -Seconds 1 }
}
$existingSponsor = Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('msedge.exe','chrome.exe') -and $_.CommandLine -like ('*' + $sponsorProfile + '*') -and $_.CommandLine -like '*--app=*' }
if ($existingSponsor) { return }
$sponsorBrowser = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Google\Chrome\Application\chrome.exe'
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $sponsorBrowser) { throw 'Install Edge or Chrome, or open http://127.0.0.1:4000/sponsor in your browser.' }
New-Item -ItemType Directory -Path $sponsorProfile -Force | Out-Null
Start-Process -FilePath $sponsorBrowser -ArgumentList @('--app=' + $sponsorAddress, '--user-data-dir="' + $sponsorProfile + '"', '--no-first-run', '--no-default-browser-check', '--window-size=720,600') -WindowStyle Normal
