#!/bin/bash
# teardown-openbao.sh — Stop OpenBao and clean up demo credentials
#
# Usage: bash relay/src/teardown-openbao.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CREDS_FILE="$RELAY_DIR/openbao-creds.json"

GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
RESET="\033[0m"
BOLD="\033[1m"

echo ""
echo -e "${YELLOW}${BOLD}  OpenBao Teardown${RESET}"
echo ""

# Kill bao server processes
PIDS=$(pgrep -f "bao server" 2>/dev/null || echo "")

if [ -n "$PIDS" ]; then
  echo -e "  Stopping bao server (PIDs: $PIDS)..."
  kill $PIDS 2>/dev/null || true
  sleep 1
  # Force kill if still running
  kill -9 $PIDS 2>/dev/null || true
  echo -e "  ${GREEN}✅ OpenBao stopped${RESET}"
else
  echo -e "  ${YELLOW}No bao server process found${RESET}"
fi

# Also try by PID from creds file
if [ -f "$CREDS_FILE" ]; then
  PID=$(python3 -c "import json; d=json.load(open('$CREDS_FILE')); print(d.get('pid',''))" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo -e "  Stopping PID $PID from creds file..."
    kill "$PID" 2>/dev/null || true
    sleep 0.5
    kill -9 "$PID" 2>/dev/null || true
  fi
fi

# Remove credentials file
if [ -f "$CREDS_FILE" ]; then
  rm "$CREDS_FILE"
  echo -e "  ${GREEN}✅ Removed: $CREDS_FILE${RESET}"
fi

# Clean up tmp log files (optional)
rm -f /tmp/openbao-oracle-demo/bao-dev.log 2>/dev/null || true
rm -f /tmp/openbao-oracle-demo/relay-policy.hcl 2>/dev/null || true

echo ""
echo -e "  ${GREEN}${BOLD}Teardown complete.${RESET}"
echo ""
