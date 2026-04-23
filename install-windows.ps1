# install-windows.ps1 — The Closer: One-Click Windows Installer
# Run as Administrator in PowerShell:
#   Right-click PowerShell → "Run as Administrator"
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\install-windows.ps1

$REPO_URL  = "https://github.com/arstandr/baseball.git"
$INSTALL_DIR = "$env:USERPROFILE\MoneyTree"
$NODE_VERSION = "20"

Write-Host ""
Write-Host "╔════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║         THE CLOSER  ⚾              ║" -ForegroundColor Green
Write-Host "║   Money Tree 2.0 — Live Monitor    ║" -ForegroundColor Green
Write-Host "╚════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

# ── 1. Install Node.js ────────────────────────────────────────────────────────
Write-Host "── Checking Node.js…" -ForegroundColor Cyan
$nodeInstalled = $null
try { $nodeInstalled = node --version 2>$null } catch {}

if (-not $nodeInstalled) {
    Write-Host "  Installing Node.js v$NODE_VERSION via winget…" -ForegroundColor Yellow
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
    Write-Host "  Node.js installed." -ForegroundColor Green
} else {
    Write-Host "  Node.js already installed: $nodeInstalled" -ForegroundColor Green
}

# ── 2. Install Git ────────────────────────────────────────────────────────────
Write-Host "── Checking Git…" -ForegroundColor Cyan
$gitInstalled = $null
try { $gitInstalled = git --version 2>$null } catch {}

if (-not $gitInstalled) {
    Write-Host "  Installing Git via winget…" -ForegroundColor Yellow
    winget install Git.Git --silent --accept-package-agreements --accept-source-agreements
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
    Write-Host "  Git installed." -ForegroundColor Green
} else {
    Write-Host "  Git already installed: $gitInstalled" -ForegroundColor Green
}

# ── 3. Clone or update repo ───────────────────────────────────────────────────
Write-Host "── Setting up repo at $INSTALL_DIR…" -ForegroundColor Cyan
if (Test-Path "$INSTALL_DIR\.git") {
    Write-Host "  Repo exists — pulling latest…" -ForegroundColor Yellow
    Set-Location $INSTALL_DIR
    git pull origin main
} else {
    Write-Host "  Cloning repo…" -ForegroundColor Yellow
    git clone $REPO_URL $INSTALL_DIR
    Set-Location $INSTALL_DIR
}
Write-Host "  Repo ready." -ForegroundColor Green

# ── 4. Install npm dependencies ───────────────────────────────────────────────
Write-Host "── Installing dependencies…" -ForegroundColor Cyan
npm install --quiet
Write-Host "  Dependencies installed." -ForegroundColor Green

# ── 5. Create .env if it doesn't exist ───────────────────────────────────────
Write-Host "── Checking .env…" -ForegroundColor Cyan
if (-not (Test-Path ".env")) {
    Write-Host "  Creating .env — you'll need to fill in your credentials." -ForegroundColor Yellow
    @"
# Money Tree 2.0 — The Closer
# Copy your credentials from the Mac .env file

TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=

# Kalshi credentials for live trading
KALSHI_KEY_ID=
KALSHI_PRIVATE_KEY_PATH=
LIVE_TRADING=true
"@ | Out-File -FilePath ".env" -Encoding utf8
    Write-Host "  .env created. Edit it with your credentials before starting." -ForegroundColor Yellow
    notepad .env
    Read-Host "  Press Enter when you've saved your .env file"
} else {
    Write-Host "  .env already exists." -ForegroundColor Green
}

# ── 6. Create startup batch file ─────────────────────────────────────────────
Write-Host "── Creating launcher…" -ForegroundColor Cyan
$launchScript = "$INSTALL_DIR\start-closer.bat"
@"
@echo off
title The Closer - Money Tree 2.0
cd /d "$INSTALL_DIR"
echo.
echo  Starting The Closer...
echo.
node scripts/closer/launcher.js
pause
"@ | Out-File -FilePath $launchScript -Encoding ascii
Write-Host "  Launcher created: $launchScript" -ForegroundColor Green

# ── 7. Create desktop shortcut ────────────────────────────────────────────────
Write-Host "── Creating desktop shortcut…" -ForegroundColor Cyan
$desktopPath = [System.Environment]::GetFolderPath("Desktop")
$shortcutPath = "$desktopPath\The Closer.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $launchScript
$shortcut.WorkingDirectory = $INSTALL_DIR
$shortcut.Description = "The Closer - Money Tree 2.0 Live Monitor"
$shortcut.Save()
Write-Host "  Desktop shortcut created." -ForegroundColor Green

# ── 8. Done ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "╔════════════════════════════════════╗" -ForegroundColor Green
Write-Host "║         ✅ INSTALL COMPLETE         ║" -ForegroundColor Green
Write-Host "╚════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Double-click 'The Closer' on your desktop to start." -ForegroundColor White
Write-Host "  The agent will auto-update whenever new code is pushed." -ForegroundColor White
Write-Host ""

$launch = Read-Host "Start The Closer now? (y/n)"
if ($launch -eq "y" -or $launch -eq "Y") {
    Start-Process $launchScript
}
