#!/usr/bin/env bash
# Install cmux-bridge as a per-user launchd agent so it starts at login and stays
# up (KeepAlive). Binds the Tailscale IP with auth ON by default.
#
#   bash scripts/install-launchd.sh
#   tail -f ~/.cmux-bridge/bridge.log     # watch for the pairing code
set -euo pipefail

LABEL="${CMUX_BRIDGE_LABEL:-dev.cmuxmobile.bridge}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
BUN="$(command -v bun || true)"
[ -n "$BUN" ] || { echo "error: bun not found in PATH" >&2; exit 1; }

mkdir -p "$HOME/.cmux-bridge" "$HOME/Library/LaunchAgents"

# Escape values destined for plist XML (paths may legally contain & < > ").
xml_escape() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g; s/"/\&quot;/g'; }
BUN_X="$(xml_escape "$BUN")"
MAIN_X="$(xml_escape "$REPO/packages/bridge/src/main.ts")"
REPO_X="$(xml_escape "$REPO")"
LOG_X="$(xml_escape "$HOME/.cmux-bridge/bridge.log")"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BUN_X</string>
    <string>run</string>
    <string>$MAIN_X</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO_X</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_X</string>
  <key>StandardErrorPath</key><string>$LOG_X</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <!-- "tailnet" = any device on your own tailnet connects with no code (no client
         storage needed). Change to "token" for per-device bearer tokens. -->
    <key>CMUX_BRIDGE_AUTH</key><string>tailnet</string>
  </dict>
</dict>
</plist>
PLIST_EOF

DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL" || true

echo "Installed $LABEL."
echo "Logs: ~/.cmux-bridge/bridge.log  (the pairing code is printed there)"
echo "Pair a device: open the printed URL on your phone and enter the code,"
echo "  or run: bun run scripts/pair-device.ts add <name>"
