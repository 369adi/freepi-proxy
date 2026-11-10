@echo off
setlocal
cd /d "%~dp0"

echo.
echo ============================================================
echo  free-pi: Account Hinzufuegen (GitHub Auto-Authorize)
echo ============================================================
echo.

node add-account.mjs
echo.
pause
