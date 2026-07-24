@echo off
setlocal
cd /d "%~dp0\.."

if "%~1"=="" (
  node scripts\deploy.mjs
) else (
  node scripts\deploy.mjs %*
)

if errorlevel 1 (
  echo.
  echo Deploy failed.
  pause
  exit /b 1
)

echo.
pause
