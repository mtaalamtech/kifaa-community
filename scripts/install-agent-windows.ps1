# Kifaa Agent Installer — Windows
# Run as Administrator in PowerShell:
# .\install-agent-windows.ps1 -Server http://kifaa.kenyanut.com -Secret <REGISTRATION_SECRET>

param(
    [Parameter(Mandatory=$true)]
    [string]$Server,

    [Parameter(Mandatory=$true)]
    [string]$Secret
)

$AgentDir   = "C:\Program Files\KifaaAgent"
$BinaryName = "kifaa-agent-windows-amd64.exe"
$ServiceName = "KifaaAgent"

Write-Host "[*] Installing Kifaa Agent..." -ForegroundColor Cyan

# Create directory
New-Item -ItemType Directory -Force -Path $AgentDir | Out-Null
New-Item -ItemType Directory -Force -Path "$env:ProgramData\KifaaAgent" | Out-Null

# Download binary
Write-Host "[*] Downloading agent binary..."
$url = "$Server/downloads/$BinaryName"
$dest = "$AgentDir\kifaa-agent.exe"
Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing

# Register
Write-Host "[*] Registering with server..."
& $dest --register --server $Server --secret $Secret
if ($LASTEXITCODE -ne 0) {
    Write-Host "[!] Registration failed" -ForegroundColor Red
    exit 1
}

# Remove existing service if present
if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    Write-Host "[*] Removing existing service..."
    Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
}

# Install as Windows service
$svcParams = @{
    Name = $ServiceName
    BinaryPathName = "`"$dest`""
    DisplayName = "Kifaa Endpoint Agent"
    StartupType = "Automatic"
    Description = "Kifaa endpoint monitoring and management agent"
}
New-Service @svcParams
Start-Service -Name $ServiceName

# Register in Programs and Features with icon
$agentExe  = Join-Path $AgentDir "kifaa-agent.exe"
$uninstallKey = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\KifaaAgent"
New-Item -Path $uninstallKey -Force | Out-Null
Set-ItemProperty -Path $uninstallKey -Name "DisplayName"     -Value "Kifaa Agent"
Set-ItemProperty -Path $uninstallKey -Name "DisplayVersion"  -Value "1.4.2"
Set-ItemProperty -Path $uninstallKey -Name "Publisher"       -Value "Kifaa"
Set-ItemProperty -Path $uninstallKey -Name "InstallLocation" -Value $AgentDir
Set-ItemProperty -Path $uninstallKey -Name "DisplayIcon"     -Value "`"$agentExe`",0"
Set-ItemProperty -Path $uninstallKey -Name "UninstallString" -Value "sc.exe delete KifaaAgent"
Set-ItemProperty -Path $uninstallKey -Name "NoModify"        -Value 1 -Type DWord
Set-ItemProperty -Path $uninstallKey -Name "EstimatedSize"   -Value ([math]::Round((Get-Item $agentExe).Length / 1024)) -Type DWord

Write-Host "[OK] Kifaa Agent installed and running!" -ForegroundColor Green
Write-Host "     Status: Get-Service KifaaAgent"
Write-Host "     Logs:   Get-EventLog -LogName Application -Source KifaaAgent"
