@echo off
setlocal
cd /d "%~dp0"
title free-pi proxy - Setup

echo.
echo  ============================================================
echo   free-pi proxy - Setup
echo  ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js wurde nicht gefunden.
  echo.
  echo   1. Download:  https://nodejs.org  ^(LTS-Version^)
  echo   2. Installieren, danach dieses Fenster schliessen
  echo   3. Setup.cmd erneut starten
  echo.
  pause
  exit /b 1
)

node tools\setup.mjs %*
set RC=%ERRORLEVEL%

echo.
if "%RC%"=="0" (
  echo   Setup abgeschlossen.
  echo.
  echo   Naechster Schritt:  Start-Proxy.cmd doppelklicken
) else (
  echo   Setup mit Fehler beendet ^(Code %RC%^).
)
echo.
pause
exit /b %RC%
