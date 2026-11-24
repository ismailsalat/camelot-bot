@echo off
setlocal
cd /d "%~dp0"
title Camelot TV - Online (Fedora WSL)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\WINDOWS-CAMELOT.ps1"
if errorlevel 1 (echo. & echo Camelot TV did not start. Read the error above. & pause)
