@echo off
setlocal
cd /d "%~dp0"
title Free-Pi Google Drive Setup
node tools\google-cloud-setup.mjs %*
echo.
pause
