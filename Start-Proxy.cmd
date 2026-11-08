@echo off
powershell.exe -NoProfile -Command "Start-ScheduledTask -TaskName 'FreePi Proxy'; Write-Host 'Proxy managed in the background: http://127.0.0.1:4000/v1'; Write-Host 'Logs: %~dp0logs'"
pause
