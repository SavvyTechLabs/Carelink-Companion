param(
    [string]$Version = "v1.2.0",
    [string]$StagingDir = "staging",
    [string]$DistDir = "dist"
)

Write-Host "Building portable bundle for CareLink Companion ($Version)"

if (Test-Path $StagingDir) { Remove-Item -Recurse -Force $StagingDir }
New-Item -ItemType Directory -Path $StagingDir | Out-Null

# Copy node executable from current Node installation
$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) {
    Write-Host "Could not find 'node' in PATH. Please download a Node portable ZIP and set NODE_PORTABLE_ZIP env var or install Node locally." -ForegroundColor Yellow
    exit 1
}

$nodeDir = Join-Path $StagingDir "node"
New-Item -ItemType Directory -Path $nodeDir | Out-Null
Copy-Item -Path $nodeExe -Destination (Join-Path $nodeDir "node.exe") -Force

# Copy app files
Write-Host "Copying app files..."
Copy-Item -Path "tools" -Destination $StagingDir -Recurse -Force

# Install production dependencies into a temporary node_modules if not present
if (-not (Test-Path "node_modules")) {
    Write-Host "No node_modules found - running npm ci --production"
    npm ci --production
}

Copy-Item -Path "node_modules" -Destination $StagingDir -Recurse -Force
Copy-Item -Path "package.json" -Destination $StagingDir -Force

# Create start.bat
$startBat = @'
@echo off
:: Start CareLink Companion using the included node executable
cd /d "%~dp0"
"%~dp0node\node.exe" "%~dp0tools\carelink-companion.js"
pause
'@
Set-Content -Path (Join-Path $StagingDir "start.bat") -Value $startBat -Encoding ASCII

# Create README
$readme = @"
CareLink Companion (Windows portable)

Contents:
- node\node.exe  (copied from the machine used to build this bundle)
- tools\         (companion scripts)
- node_modules\  (production dependencies)
- start.bat       (double-click to start companion)

Usage:
1. Extract the ZIP to a folder on your Windows PC.
2. Double-click `start.bat` to start the companion. A console window will open and the companion will start a local server on http://127.0.0.1:8766
3. If Windows SmartScreen blocks execution, choose 'More info' → 'Run anyway'.

Notes:
- This portable bundle copies the `node.exe` from the builder's machine. If the target Windows lacks the required Visual C++ runtime, the bundled node may not run. In that case, consider using the installer from nodejs.org or request a signed official exe.
"@

Set-Content -Path (Join-Path $StagingDir "README.txt") -Value $readme -Encoding UTF8

# Create dist dir
if (-not (Test-Path $DistDir)) { New-Item -ItemType Directory -Path $DistDir | Out-Null }

$zipName = "$DistDir\carelink-companion-windows-portable-$Version.zip"
if (Test-Path $zipName) { Remove-Item $zipName -Force }

Write-Host "Creating ZIP: $zipName"
Compress-Archive -Path (Join-Path $StagingDir '*') -DestinationPath $zipName -Force

Write-Host "Portable bundle created: $zipName"
