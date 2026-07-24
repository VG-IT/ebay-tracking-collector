<#
.SYNOPSIS
  Deploy latest GitHub Release zip (no Node/npm required).
  Compatible with Windows PowerShell 4.0+.

.PARAMETER InstallDir
  Default: %LOCALAPPDATA%\ebay-tracking-collector

.PARAMETER DryRun
  Print plan only.

.PARAMETER Quiet
  Do not open chrome://extensions (for Scheduled Task runs).
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "",
  [switch]$DryRun,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"
$Repo = "VG-IT/ebay-tracking-collector"
$Headers = @{
  "Accept"     = "application/vnd.github+json"
  "User-Agent" = "ebay-tracking-collector-deploy"
}

# Older Windows / .NET defaults can omit TLS 1.2; GitHub requires it.
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
} catch {
  [Net.ServicePointManager]::SecurityProtocol = [Enum]::ToObject(
    [Net.SecurityProtocolType],
    3072
  )
}

function Fail([string]$Message) {
  Write-Host ""
  Write-Host ("ERROR: " + $Message) -ForegroundColor Red
  exit 1
}

function Expand-ZipFile([string]$ZipPath, [string]$Destination) {
  # Expand-Archive needs PowerShell 5+; use .NET for PowerShell 4.
  if (Get-Command Expand-Archive -ErrorAction SilentlyContinue) {
    if (-not (Test-Path $Destination)) {
      New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    }
    Expand-Archive -Path $ZipPath -DestinationPath $Destination -Force
    return
  }

  if (Test-Path $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $Destination)
}

if (-not $InstallDir) {
  if ($env:EBAY_TRACKING_COLLECTOR_HOME) {
    $InstallDir = $env:EBAY_TRACKING_COLLECTOR_HOME
  } else {
    $InstallDir = Join-Path $env:LOCALAPPDATA "ebay-tracking-collector"
  }
}
$InstallDir = [System.IO.Path]::GetFullPath($InstallDir)

Write-Host ""
Write-Host "-> Fetch latest release" -ForegroundColor Cyan
try {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -Headers $Headers
} catch {
  Fail ("GitHub API error: " + $_.Exception.Message)
}

$tag = $release.tag_name
$version = $tag -replace '^v', ''
$zipAsset = $release.assets |
  Where-Object { $_.name -eq ("ebay-tracking-collector-" + $version + ".zip") } |
  Select-Object -First 1
if (-not $zipAsset) {
  $zipAsset = $release.assets | Where-Object { $_.name -like "*.zip" } | Select-Object -First 1
}
if (-not $zipAsset) {
  Fail ("No zip on ${tag}: " + $release.html_url)
}

$installedVersion = $null
$localManifest = Join-Path $InstallDir "manifest.json"
if (Test-Path $localManifest) {
  try {
    $installedVersion = (Get-Content $localManifest -Raw | ConvertFrom-Json).version
  } catch { }
}

Write-Host ("  release:   " + $release.html_url)
Write-Host ("  zip:       " + $zipAsset.name)
Write-Host ("  install:   " + $InstallDir)
Write-Host ("  installed: " + $(if ($installedVersion) { "v$installedVersion" } else { "(none)" }))

if ($installedVersion -eq $version) {
  Write-Host ""
  Write-Host ("OK: Already on v" + $version) -ForegroundColor Green
  exit 0
}

if ($DryRun) {
  Write-Host ""
  Write-Host "Dry run only."
  exit 0
}

$tmpRoot = Join-Path $env:TEMP ("ebay-tracking-deploy-" + [guid]::NewGuid().ToString("N"))
$zipPath = Join-Path $tmpRoot $zipAsset.name
$extractDir = Join-Path $tmpRoot "extract"
New-Item -ItemType Directory -Path $tmpRoot -Force | Out-Null

try {
  Write-Host ""
  Write-Host ("-> Download " + $zipAsset.name) -ForegroundColor Cyan
  Invoke-WebRequest -Uri $zipAsset.browser_download_url -Headers @{ "User-Agent" = "ebay-tracking-collector-deploy" } -OutFile $zipPath -UseBasicParsing
  if (-not (Test-Path $zipPath) -or (Get-Item $zipPath).Length -lt 100) {
    Fail "Downloaded zip looks empty"
  }

  Write-Host ""
  Write-Host "-> Extract" -ForegroundColor Cyan
  Expand-ZipFile -ZipPath $zipPath -Destination $extractDir
  if (-not (Test-Path (Join-Path $extractDir "manifest.json"))) {
    Fail "Zip root must contain manifest.json"
  }

  Write-Host ""
  Write-Host ("-> Install " + $InstallDir) -ForegroundColor Cyan
  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  Get-ChildItem -LiteralPath $InstallDir -Force | Remove-Item -Recurse -Force
  Copy-Item -Path (Join-Path $extractDir "*") -Destination $InstallDir -Recurse -Force

  Write-Host ""
  Write-Host ("OK: Deployed v" + $version + " -> " + $InstallDir) -ForegroundColor Green
  Write-Host "Next: chrome://extensions -> Load unpacked (first time) or Reload"

  if (-not $Quiet) {
    $chrome = @(
      (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
      (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe"),
      (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($chrome) {
      Start-Process $chrome "chrome://extensions"
    }
  }
} finally {
  Remove-Item -LiteralPath $tmpRoot -Recurse -Force -ErrorAction SilentlyContinue
}
