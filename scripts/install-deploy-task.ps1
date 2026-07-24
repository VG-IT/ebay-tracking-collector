<#
.SYNOPSIS
  Register a Windows Scheduled Task that runs deploy-windows.ps1.
  Compatible with Windows PowerShell 4.0+.

.PARAMETER Time
  Daily local time (HH:mm). Default 09:00.

.PARAMETER TaskName
  Scheduled task name.

.PARAMETER InstallDir
  Passed through to deploy-windows.ps1 when set.
#>
[CmdletBinding()]
param(
  [string]$Time = "09:00",
  [string]$TaskName = "EbayTrackingCollector-Deploy",
  [string]$InstallDir = ""
)

$ErrorActionPreference = "Stop"

$deployScript = Join-Path $PSScriptRoot "deploy-windows.ps1"
if (-not (Test-Path $deployScript)) {
  Write-Host "ERROR: Missing deploy-windows.ps1 next to this script." -ForegroundColor Red
  exit 1
}

if ($Time -notmatch '^\d{1,2}:\d{2}$') {
  Write-Host "ERROR: -Time must be HH:mm (e.g. 09:00)." -ForegroundColor Red
  exit 1
}

$parts = $Time.Split(":")
$hour = [int]$parts[0]
$minute = [int]$parts[1]
if ($hour -lt 0 -or $hour -gt 23 -or $minute -lt 0 -or $minute -gt 59) {
  Write-Host "ERROR: Invalid -Time $Time" -ForegroundColor Red
  exit 1
}

$argList = @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-WindowStyle", "Hidden",
  "-File", "`"$deployScript`"",
  "-Quiet"
)
if ($InstallDir) {
  $argList += @("-InstallDir", "`"$InstallDir`"")
}

$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument ($argList -join " ")

$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Download and install the latest eBay Tracking Collector release zip." `
  -Force | Out-Null

Write-Host ""
Write-Host ("OK: Scheduled task registered: " + $TaskName) -ForegroundColor Green
Write-Host ("  runs daily at " + $Time + " (local time)")
Write-Host ("  script: " + $deployScript)
if ($InstallDir) {
  Write-Host ("  install dir: " + $InstallDir)
}
Write-Host ""
Write-Host "Manage: Task Scheduler -> Task Scheduler Library -> $TaskName"
Write-Host "Remove:  powershell -File scripts\uninstall-deploy-task.ps1"
