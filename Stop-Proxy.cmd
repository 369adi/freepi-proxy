@echo off
setlocal
cd /d "%~dp0"
title free-pi proxy - stop

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js wurde nicht gefunden.
  pause
  exit /b 1
)

node tools\stop.mjs
echo.
timeout /t 2 >nul
exit /b 0
