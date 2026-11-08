@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js wurde nicht gefunden. Bitte Setup.cmd ausfuehren.
  timeout /t 5 >nul
  exit /b 1
)
node tools\watchdog.mjs
