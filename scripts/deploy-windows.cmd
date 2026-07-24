@echo off
setlocal
cd /d "%~dp0"

REM One-click deploy (no Node/npm). Double-click to run.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0deploy-windows.ps1" %*

if errorlevel 1 (
  echo.
  echo Deploy failed.
  pause
  exit /b 1
)

echo.
pause
