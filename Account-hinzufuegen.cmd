@echo off
setlocal
cd /d "%~dp0"

echo.
echo  ============================================================
echo   free-pi Proxy  -  Account hinzufuegen
echo  ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  Node.js wurde nicht gefunden.
  echo  Bitte installieren: https://nodejs.org
  echo.
  pause
  exit /b 1
)

node tools\freepi-accounts.mjs add --many
echo.
pause
