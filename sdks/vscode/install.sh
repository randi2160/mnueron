#!/usr/bin/env bash
# mnueron VS Code extension — one-script local installer (mac/linux).
#
# Run from the sdks/vscode/ folder:
#   ./install.sh
#
# Same flow as install.ps1 — see that file for the full breakdown.
set -euo pipefail

step() { printf "\n==> %s\n" "$1"; }
need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: '$1' not on PATH." >&2
    echo "       $2" >&2
    exit 1
  fi
}

cd "$(dirname "$0")"

step "Verifying prerequisites"
need node "Install Node.js 18+ from https://nodejs.org/en/download"
need npm  "Comes with Node.js."
need code "Open VS Code -> Cmd/Ctrl+Shift+P -> 'Shell Command: Install code in PATH'."
printf "    Node:    %s\n"  "$(node --version)"
printf "    npm:     %s\n"  "$(npm --version)"
printf "    VS Code: %s\n"  "$(code --version | head -n 1)"

step "Installing extension dependencies"
npm install --silent

step "Installing @vscode/vsce globally if missing"
if ! command -v vsce >/dev/null 2>&1; then
  npm install -g @vscode/vsce
fi
printf "    vsce:    %s\n"  "$(vsce --version)"

step "Building TypeScript"
npm run build

step "Packaging .vsix"
rm -f mnueron-vscode-*.vsix
vsce package --no-dependencies --skip-license

VSIX=$(ls mnueron-vscode-*.vsix 2>/dev/null | head -n 1)
if [ -z "$VSIX" ]; then
  echo "ERROR: vsce package did not produce a .vsix file." >&2
  exit 1
fi
printf "    Built:  %s (%s bytes)\n" "$VSIX" "$(stat -c%s "$VSIX" 2>/dev/null || stat -f%z "$VSIX")"

step "Installing extension into VS Code"
code --install-extension "$VSIX" --force

cat <<MSG

==> Done.

Next:
  1. Reload any open VS Code window (Cmd/Ctrl+Shift+P -> 'Developer: Reload Window')
  2. Click the mnueron icon in the activity bar (left edge)
  3. Settings -> 'mnueron' to set local-vs-hosted mode + token
  4. Press Cmd/Ctrl+Shift+M to save a selection; Cmd/Ctrl+Shift+R to recall

Local mode? Run 'mnueron dashboard' in a terminal so 127.0.0.1:3122 is up.
Hosted mode? Paste a token from /account-settings/tokens into mnueron.apiToken.
MSG
