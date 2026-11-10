@echo off
setlocal
cd /d "%~dp0"
title Free-Pi Google Cloud ^& Drive Setup
node tools\google-cloud-setup.mjs %*
if %ERRORLEVEL% NEQ 0 (
  echo.
  pause
)
