#!/usr/bin/env bash
# Remove the cmux-bridge launchd agent.
set -euo pipefail

LABEL="${CMUX_BRIDGE_LABEL:-dev.cmuxmobile.bridge}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Uninstalled $LABEL. (Token store at ~/.cmux-bridge/tokens.json left intact.)"
