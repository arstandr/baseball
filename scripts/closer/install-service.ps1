# install-service.ps1 — Register The Closer as a Windows Task Scheduler task.
#
# Runs as the current user with "Run whether user is logged on or not" (S4U logon),
# so the process survives logoff and starts automatically at boot.
# The .env file in the project root is loaded by dotenv at startup — no manual
# environment variable configuration needed in Task Scheduler.
#
# USAGE (run as Administrator):
#   powershell -ExecutionPolicy Bypass -File scripts\closer\install-service.ps1
#
# To start immediately after install:
#   Start-ScheduledTask -TaskName "TheCloser-MoneyTree"

param(
  [string]$TaskName = "TheCloser-MoneyTree"
)

$ErrorActionPreference = "Stop"

# Resolve project root (two directories up from this script)
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$WorkDir   = (Resolve-Path (Join-Path $ScriptDir "..\..")).Path
$BatFile   = Join-Path $WorkDir "start-closer.bat"

Write-Host ""
Write-Host "The Closer — Task Scheduler Install" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "  Project root : $WorkDir"
Write-Host "  Bat file     : $BatFile"
Write-Host "  Task name    : $TaskName"
Write-Host "  Run as       : $env:USERDOMAIN\$env:USERNAME"
Write-Host ""

if (-not (Test-Path $BatFile)) {
  Write-Error "start-closer.bat not found at $BatFile.`nRun 'node scripts/closer/launcher.js' once first so it creates the bat file."
  exit 1
}

# Verify node is accessible
try {
  $nodePath = (Get-Command node -ErrorAction Stop).Source
  Write-Host "  Node.js      : $nodePath" -ForegroundColor Green
} catch {
  Write-Error "node.exe not found in PATH. Install Node.js and make sure it is on the system PATH."
  exit 1
}

# Build task components
$Action = New-ScheduledTaskAction `
  -Execute       "cmd.exe" `
  -Argument      "/c `"$BatFile`"" `
  -WorkingDirectory $WorkDir

$Trigger = New-ScheduledTaskTrigger -AtStartup

# S4U = Service For User: runs without user being logged on; no password stored.
$Principal = New-ScheduledTaskPrincipal `
  -UserId   "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType S4U `
  -RunLevel  Highest

$Settings = New-ScheduledTaskSettingsSet `
  -RestartCount          999 `
  -RestartInterval       (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit    ([System.TimeSpan]::Zero) `
  -MultipleInstances     IgnoreNew `
  -StartWhenAvailable

# Remove existing task silently, then register fresh
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue

Register-ScheduledTask `
  -TaskName    $TaskName `
  -Action      $Action `
  -Trigger     $Trigger `
  -Principal   $Principal `
  -Settings    $Settings `
  -Description "The Closer — Money Tree 2.0 live betting monitor (auto-restarts, survives logoff)" `
  | Out-Null

Write-Host ""
Write-Host "DONE — task '$TaskName' registered." -ForegroundColor Green
Write-Host ""
Write-Host "Useful commands:" -ForegroundColor Yellow
Write-Host "  Start now  : Start-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Check state: Get-ScheduledTask   -TaskName '$TaskName' | Select-Object State"
Write-Host "  View log   : Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host "  Remove task: Unregister-ScheduledTask -TaskName '$TaskName'"
Write-Host ""
Write-Host "Closer log file: $WorkDir\logs\closer.log"
Write-Host "(Rotates automatically at 10 MB, keeps one backup as closer.log.1)"
Write-Host ""
