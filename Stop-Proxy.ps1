$ErrorActionPreference = 'Stop'
Stop-ScheduledTask -TaskName 'FreePi Proxy'
$proxyPidPath = Join-Path $PSScriptRoot 'logs\proxy.pid'
if (Test-Path -LiteralPath $proxyPidPath) {
    $proxyOwnedPid = [int](Get-Content -LiteralPath $proxyPidPath)
    $proxyOwnedProcess = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $proxyOwnedPid)
    if ($proxyOwnedProcess.Name -eq 'node.exe' -and $proxyOwnedProcess.CommandLine -match 'proxy\.mjs') {
        Stop-Process -Id $proxyOwnedPid -Force -ErrorAction SilentlyContinue
    }
}
Write-Host 'Proxy stopped. It will start again at your next Windows sign-in.'
