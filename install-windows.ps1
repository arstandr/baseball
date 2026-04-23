# install-windows.ps1 — The Closer: One-Click Windows Installer
# ─────────────────────────────────────────────────────────────
# HOW TO RUN:
#   1. Open PowerShell as Administrator (right-click → Run as Administrator)
#   2. Paste and run this line first:
#        Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   3. Then run:
#        .\install-windows.ps1

$REPO_URL    = "https://github.com/arstandr/baseball.git"
$INSTALL_DIR = "$env:USERPROFILE\MoneyTree"
$TEMP        = "$env:TEMP\closer-install"

function Write-Step($msg) { Write-Host "`n── $msg" -ForegroundColor Cyan }
function Write-OK($msg)   { Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "  ⚠ $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "  ✗ $msg" -ForegroundColor Red }

Clear-Host
Write-Host ""
Write-Host "  ╔════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║         THE CLOSER  ⚾              ║" -ForegroundColor Green
Write-Host "  ║   Money Tree 2.0 — Live Monitor    ║" -ForegroundColor Green
Write-Host "  ╚════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""

New-Item -ItemType Directory -Force -Path $TEMP | Out-Null

# ── 1. Node.js ────────────────────────────────────────────────────────────────
Write-Step "Checking Node.js..."

$nodeOk = $false
try {
    $v = & node --version 2>$null
    if ($v -match "v\d+") { $nodeOk = $true; Write-OK "Node.js already installed: $v" }
} catch {}

if (-not $nodeOk) {
    Write-Warn "Node.js not found — downloading installer..."
    $nodeMsi = "$TEMP\node-installer.msi"
    $nodeUrl = "https://nodejs.org/dist/v20.19.0/node-v20.19.0-x64.msi"
    Write-Host "  Downloading from $nodeUrl" -ForegroundColor Gray
    try {
        Invoke-WebRequest -Uri $nodeUrl -OutFile $nodeMsi -UseBasicParsing
        Write-Host "  Running installer (this takes ~30 seconds)..." -ForegroundColor Gray
        Start-Process msiexec.exe -ArgumentList "/i `"$nodeMsi`" /quiet /norestart" -Wait
        # Refresh PATH
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("PATH","User")
        $v = & node --version 2>$null
        if ($v) { Write-OK "Node.js installed: $v" }
        else     { Write-Fail "Node.js install failed — please install manually from nodejs.org"; exit 1 }
    } catch {
        Write-Fail "Download failed: $_"
        Write-Host "  Please download Node.js manually from: https://nodejs.org/en/download" -ForegroundColor Yellow
        exit 1
    }
}

# ── 2. Git ────────────────────────────────────────────────────────────────────
Write-Step "Checking Git..."

$gitOk = $false
try {
    $v = & git --version 2>$null
    if ($v -match "git version") { $gitOk = $true; Write-OK "Git already installed: $v" }
} catch {}

if (-not $gitOk) {
    Write-Warn "Git not found — downloading installer..."
    $gitExe = "$TEMP\git-installer.exe"
    $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.44.0.windows.1/Git-2.44.0-64-bit.exe"
    Write-Host "  Downloading from GitHub..." -ForegroundColor Gray
    try {
        Invoke-WebRequest -Uri $gitUrl -OutFile $gitExe -UseBasicParsing
        Write-Host "  Running installer (silent)..." -ForegroundColor Gray
        Start-Process $gitExe -ArgumentList "/VERYSILENT /NORESTART /NOCANCEL /SP-" -Wait
        $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" +
                    [System.Environment]::GetEnvironmentVariable("PATH","User") + ";" +
                    "C:\Program Files\Git\cmd"
        $v = & git --version 2>$null
        if ($v) { Write-OK "Git installed: $v" }
        else     { Write-Fail "Git install failed — please install manually from git-scm.com"; exit 1 }
    } catch {
        Write-Fail "Download failed: $_"
        Write-Host "  Please download Git manually from: https://git-scm.com/download/win" -ForegroundColor Yellow
        exit 1
    }
}

# ── 3. Clone / update repo ────────────────────────────────────────────────────
Write-Step "Setting up Money Tree repo at $INSTALL_DIR..."

if (Test-Path "$INSTALL_DIR\.git") {
    Write-Warn "Repo already exists — pulling latest code..."
    Push-Location $INSTALL_DIR
    & git pull origin main
    Pop-Location
} else {
    Write-Host "  Cloning repo..." -ForegroundColor Gray
    & git clone $REPO_URL $INSTALL_DIR
    if ($LASTEXITCODE -ne 0) { Write-Fail "Clone failed. Check your internet connection."; exit 1 }
}
Write-OK "Repo ready at $INSTALL_DIR"

# ── 4. Copy .env ──────────────────────────────────────────────────────────────
Write-Step "Setting up credentials..."

$envSrc = Join-Path $PSScriptRoot ".env"
$envDst = Join-Path $INSTALL_DIR ".env"

if (Test-Path $envSrc) {
    Copy-Item $envSrc $envDst -Force
    Write-OK ".env credentials copied"
} elseif (Test-Path $envDst) {
    Write-OK ".env already exists in install dir"
} else {
    Write-Warn "No .env file found — creating template..."
    @"
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
LIVE_TRADING=true
KALSHI_KEY_ID=
KALSHI_KEY_PATH=
DISCORD_WEBHOOK_URL=
"@ | Out-File -FilePath $envDst -Encoding utf8
    Write-Host "  Opening .env for editing — fill in your credentials then save and close." -ForegroundColor Yellow
    Start-Process notepad $envDst -Wait
}

# ── 5. Install npm packages ───────────────────────────────────────────────────
Write-Step "Installing Node.js packages (this takes ~1 minute)..."

Push-Location $INSTALL_DIR
& npm install --omit=dev 2>&1 | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
if ($LASTEXITCODE -ne 0) { Write-Fail "npm install failed"; exit 1 }
Pop-Location
Write-OK "Packages installed"

# ── 6. Create start-closer.bat ───────────────────────────────────────────────
Write-Step "Creating launcher..."

$bat = "$INSTALL_DIR\start-closer.bat"
@"
@echo off
title The Closer - Money Tree 2.0
cd /d "$INSTALL_DIR"
echo.
echo  ==========================================
echo   THE CLOSER  -  Money Tree 2.0
echo  ==========================================
echo.
node scripts/closer/launcher.js
echo.
echo  The Closer has stopped. Press any key to close.
pause > nul
"@ | Out-File -FilePath $bat -Encoding ascii
Write-OK "Launcher created"

# ── 7. Desktop shortcut ───────────────────────────────────────────────────────
Write-Step "Creating desktop shortcut..."

$desktop  = [System.Environment]::GetFolderPath("Desktop")
$lnkPath  = "$desktop\The Closer.lnk"
$shell    = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($lnkPath)
$shortcut.TargetPath       = $bat
$shortcut.WorkingDirectory = $INSTALL_DIR
$shortcut.Description      = "The Closer - Money Tree 2.0 Live Monitor"
$shortcut.Save()
Write-OK "Desktop shortcut created: 'The Closer'"

# ── 8. Cleanup ────────────────────────────────────────────────────────────────
Remove-Item -Recurse -Force $TEMP -ErrorAction SilentlyContinue

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ╔════════════════════════════════════╗" -ForegroundColor Green
Write-Host "  ║       ✅  INSTALL COMPLETE          ║" -ForegroundColor Green
Write-Host "  ╚════════════════════════════════════╝" -ForegroundColor Green
Write-Host ""
Write-Host "  Double-click 'The Closer' on your desktop to start." -ForegroundColor White
Write-Host "  The site will show a green dot when it's running."   -ForegroundColor White
Write-Host ""

$go = Read-Host "  Start The Closer now? (y/n)"
if ($go -match "^[Yy]") {
    Start-Process $bat
}
