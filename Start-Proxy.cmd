@echo off
setlocal
cd /d "%~dp0"
title free-pi proxy

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js wurde nicht gefunden. Bitte Setup.cmd ausfuehren.
  pause
  exit /b 1
)

if not exist "%USERPROFILE%\.free-pi\proxy\accounts.json" (
  echo   Kein Konto eingerichtet. Bitte zuerst Setup.cmd ausfuehren.
  echo.
  pause
  exit /b 1
)

echo   Starte Proxy auf http://127.0.0.1:4000/v1
echo   Dieses Fenster offen lassen - hier erscheinen die Ads.
echo.
node proxy.mjs
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" echo   Proxy beendet mit Code %RC%.
pause
exit /b %RC%
