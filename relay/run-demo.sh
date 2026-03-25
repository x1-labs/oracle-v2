#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# run-demo.sh — Oracle V2 Demo with OpenBao Transit Signing
#
# Usage:
#   ./run-demo.sh                # Setup + run demo + tear down
#   ./run-demo.sh --setup-only   # Just set up OpenBao (download + start)
#   ./run-demo.sh --teardown-only # Just kill OpenBao and clean up
#   ./run-demo.sh --no-teardown  # Setup + run, but leave OpenBao running
#
# This script:
#   1. Downloads OpenBao (MPL 2.0 Vault fork) if not already present
#   2. Starts OpenBao in dev mode (auto-unsealed, no manual init needed)
#   3. Configures Transit secrets engine + Ed25519 signing key
#   4. Runs the TypeScript demo (price fetch + sign + security tests)
#   5. Tears down OpenBao (unless --no-teardown)
# ─────────────────────────────────────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

GREEN="\033[0;32m"
YELLOW="\033[0;33m"
RED="\033[0;31m"
CYAN="\033[0;36m"
RESET="\033[0m"
BOLD="\033[1m"

SETUP_ONLY=false
TEARDOWN_ONLY=false
NO_TEARDOWN=false

for arg in "$@"; do
  case $arg in
    --setup-only)    SETUP_ONLY=true ;;
    --teardown-only) TEARDOWN_ONLY=true ;;
    --no-teardown)   NO_TEARDOWN=true ;;
    --help|-h)
      echo ""
      echo "  Oracle V2 Demo — OpenBao Transit Signing"
      echo ""
      echo "  Usage: ./run-demo.sh [options]"
      echo ""
      echo "  Options:"
      echo "    --setup-only     Download + start OpenBao, then exit"
      echo "    --teardown-only  Stop OpenBao + clean up credentials"
      echo "    --no-teardown    Run demo but leave OpenBao running"
      echo "    --help           This message"
      echo ""
      exit 0
      ;;
    *)
      echo -e "  ${RED}Unknown option: $arg${RESET}"
      echo "  Run: ./run-demo.sh --help"
      exit 1
      ;;
  esac
done

# ─── Teardown only ────────────────────────────────────────────────────────────

if $TEARDOWN_ONLY; then
  bash "$SCRIPT_DIR/src/teardown-openbao.sh"
  exit 0
fi

# ─── Setup ────────────────────────────────────────────────────────────────────

echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  Oracle V2 Demo — OpenBao Transit${RESET}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

bash "$SCRIPT_DIR/src/setup-openbao.sh"

if $SETUP_ONLY; then
  echo -e "  ${GREEN}✅ Setup complete. OpenBao is running.${RESET}"
  echo -e "  ${YELLOW}Run demo: cd relay && npx tsx src/demo.ts${RESET}"
  echo -e "  ${YELLOW}Teardown: ./run-demo.sh --teardown-only${RESET}"
  echo ""
  exit 0
fi

# ─── Run the TypeScript demo ──────────────────────────────────────────────────

echo ""
echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${BOLD}  Running Demo...${RESET}"
echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""

# Install dependencies if needed
if [ ! -d "$SCRIPT_DIR/node_modules" ]; then
  echo -e "  ${YELLOW}Installing npm dependencies...${RESET}"
  cd "$SCRIPT_DIR" && npm install
  echo ""
fi

cd "$SCRIPT_DIR"
npx tsx src/demo.ts
DEMO_EXIT=$?

# ─── Tear down (unless --no-teardown) ─────────────────────────────────────────

if ! $NO_TEARDOWN; then
  echo ""
  echo -e "${CYAN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  echo -e "${BOLD}  Tearing down OpenBao...${RESET}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
  bash "$SCRIPT_DIR/src/teardown-openbao.sh"
else
  echo ""
  echo -e "  ${YELLOW}OpenBao left running (--no-teardown). Run teardown manually:${RESET}"
  echo -e "  ${BOLD}  ./run-demo.sh --teardown-only${RESET}"
  echo ""
fi

exit $DEMO_EXIT
