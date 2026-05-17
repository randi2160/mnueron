# mnueron VS Code extension — one-script local installer (Windows).
#
# What it does:
#   1. Verifies Node + VS Code are on PATH.
#   2. npm-installs dependencies for the extension.
#   3. Builds the TypeScript.
#   4. Builds a .vsix package with vsce.
#   5. Installs the .vsix into your local VS Code via the `code` CLI.
#   6. Tells you how to verify.
#
# Run from the sdks/vscode/ folder:
#   ./install.ps1
#
# Requires:
#   - PowerShell 5.1+ (built into Windows 10/11)
#   - Node 18+
#   - VS Code installed AND the `code` command available in PATH
#     (VS Code → Command Palette → "Shell Command: Install 'code' command in PATH")

$ErrorActionPreference = "Stop"

function Write-Step([string]$msg) {
  Write-Host ""
  Write-Host "==> $msg" -ForegroundColor Cyan
}

function Require-Command([string]$cmd, [string]$hint) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    Write-Host "ERROR: '$cmd' not on PATH." -ForegroundColor Red
    Write-Host "       $hint" -ForegroundColor Yellow
    exit 1
  }
}

# Make sure we're running in the extension folder (or a sibling)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $scriptDir

Write-Step "Verifying prerequisites"
Require-Command "node"  "Install Node.js 18+ from https://nodejs.org/en/download"
Require-Command "npm"   "Comes with Node.js — reinstall if missing."
Require-Command "code"  "Open VS Code → Cmd/Ctrl+Shift+P → 'Shell Command: Install code in PATH'."

Write-Host ("    Node:    " + (node --version))
Write-Host ("    npm:     " + (npm --version))
Write-Host ("    VS Code: " + (code --version | Select-Object -First 1))

Write-Step "Installing extension dependencies (npm install)"
npm install --silent

Write-Step "Installing @vscode/vsce globally if missing"
if (-not (Get-Command vsce -ErrorAction SilentlyContinue)) {
  npm install -g @vscode/vsce
}
Write-Host ("    vsce:    " + (vsce --version))

Write-Step "Building TypeScript"
npm run build

Write-Step "Packaging .vsix"
# Remove any prior VSIX to avoid version-pinning ambiguity
Get-ChildItem -Filter "mnueron-vscode-*.vsix" | Remove-Item -Force -ErrorAction SilentlyContinue
vsce package --no-dependencies --skip-license

$vsix = Get-ChildItem -Filter "mnueron-vscode-*.vsix" | Select-Object -First 1
if (-not $vsix) {
  Write-Host "ERROR: vsce package did not produce a .vsix file." -ForegroundColor Red
  exit 1
}
Write-Host ("    Built:  " + $vsix.Name + "  ({0:N1} KB)" -f ($vsix.Length / 1KB))

Write-Step "Installing extension into VS Code"
code --install-extension $vsix.FullName --force

Write-Host ""
Write-Host "==> Done." -ForegroundColor Green
Write-Host ""
Write-Host "Next:"
Write-Host "  1. Reload any open VS Code window (Cmd/Ctrl+Shift+P -> 'Developer: Reload Window')"
Write-Host "  2. Click the mnueron icon in the activity bar (left edge)"
Write-Host "  3. Settings -> 'mnueron' to set local-vs-hosted mode + token"
Write-Host "  4. Press Cmd/Ctrl+Shift+M to save a selection; Cmd/Ctrl+Shift+R to recall"
Write-Host ""
Write-Host "Local mode? Run 'mnueron dashboard' in a terminal so 127.0.0.1:3122 is up."
Write-Host "Hosted mode? Paste a token from /account-settings/tokens into mnueron.apiToken."
