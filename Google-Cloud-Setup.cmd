@echo off
setlocal
cd /d "%~dp0"
title Free-Pi Google Setup
set "NODE_EXE=node"
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if errorlevel 1 if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
"%NODE_EXE%" tools\google-cloud-setup.mjs %*
echo.
pause
