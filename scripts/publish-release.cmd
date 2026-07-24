@echo off
setlocal
cd /d "%~dp0\.."

if "%~1"=="" (
  node scripts\publish-release.mjs --current
) else (
  node scripts\publish-release.mjs %*
)

if errorlevel 1 (
  echo.
  echo Publish failed.
  pause
  exit /b 1
)

echo.
pause
