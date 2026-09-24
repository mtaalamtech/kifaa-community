# Kifaa Agent Updater for Windows
# Updates the agent binary WITHOUT re-registering (preserves agent ID and API key).
# Run in PowerShell as Administrator:
#   .\update-windows.ps1 -Server https://kifaa.kenyanut.com
#
# Or one-liner from server:
#   Invoke-Expression (Invoke-WebRequest -Uri "https://kifaa.kenyanut.com/downloads/update-agent.ps1" -UseBasicParsing).Content

param(
    [string]$Server = "https://kifaa.kenyanut.com",
    [string]$InstallDir = "C:\Program Files\KifaaAgent"
)

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[ERROR] Must be run as Administrator." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  Kifaa Agent Update" -ForegroundColor Cyan
Write-Host "  Server   : $Server" -ForegroundColor Gray
Write-Host "  Install  : $InstallDir" -ForegroundColor Gray
Write-Host ""

$arch = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
$downloadUrl = "$Server/downloads/kifaa-agent-windows-$arch.exe"
$dest        = "$InstallDir\kifaa-agent.exe"
$tmpDest     = "$InstallDir\kifaa-agent-new.exe"

# Verify config exists — update only makes sense if agent is already registered
$configPath = "$env:ProgramData\KifaaAgent\config.json"
if (-not (Test-Path $configPath)) {
    Write-Host "[ERROR] No config found at $configPath" -ForegroundColor Red
    Write-Host "        Run the full installer (install-windows.ps1) to do a fresh install." -ForegroundColor Yellow
    exit 1
}

Write-Host "[1/4] Downloading new agent binary..." -ForegroundColor White
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $downloadUrl -OutFile $tmpDest -UseBasicParsing
    Write-Host "      Downloaded to $tmpDest" -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Download failed: $_" -ForegroundColor Red
    exit 1
}

Write-Host "[2/4] Stopping KifaaAgent service..." -ForegroundColor White
Stop-Service -Name "KifaaAgent" -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

Write-Host "[3/4] Replacing binary..." -ForegroundColor White
try {
    Copy-Item -Path $tmpDest -Destination $dest -Force
    Remove-Item -Path $tmpDest -Force -ErrorAction SilentlyContinue
    Write-Host "      Binary replaced." -ForegroundColor Green
} catch {
    Write-Host "[ERROR] Could not replace binary: $_" -ForegroundColor Red
    Write-Host "        Try closing any programs using the agent binary and retry." -ForegroundColor Yellow
    Start-Service -Name "KifaaAgent" -ErrorAction SilentlyContinue
    exit 1
}

Write-Host "[4/4] Starting KifaaAgent service..." -ForegroundColor White
Start-Service -Name "KifaaAgent"
Start-Sleep -Seconds 2

$status = (Get-Service -Name "KifaaAgent").Status
if ($status -eq "Running") {
    Write-Host ""
    Write-Host "  [OK] Agent updated and running!" -ForegroundColor Green
    Write-Host "       Agent ID and registration preserved." -ForegroundColor Gray
    Write-Host ""
} else {
    Write-Host "[WARN] Service status: $status" -ForegroundColor Yellow
    Write-Host "       Try: Start-Service KifaaAgent" -ForegroundColor Gray
}
