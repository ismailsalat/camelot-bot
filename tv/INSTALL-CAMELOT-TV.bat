@echo off
setlocal
cd /d "%~dp0"
title Camelot TV - Setup (Fedora WSL)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\WINDOWS-CAMELOT.ps1" install
if errorlevel 1 (echo. & echo Camelot TV setup did not complete. Read the error above.)
pause
