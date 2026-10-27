@echo off
rem Double-click to start the FSK pitboard server on Windows. The real work is in start-pitboard.ps1 next to this file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-pitboard.ps1"
pause
