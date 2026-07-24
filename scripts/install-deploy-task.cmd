@echo off
setlocal
cd /d "%~dp0"

REM Register daily Windows Scheduled Task for deploy-windows.ps1
REM Default: every day 09:00 local time

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-deploy-task.ps1" %*

if errorlevel 1 (
  echo.
  echo Failed to register scheduled task.
  pause
  exit /b 1
)

echo.
pause
