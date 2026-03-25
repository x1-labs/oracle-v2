#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-openbao.sh — Download OpenBao, start in dev mode, configure Transit
#
# Usage: bash relay/src/setup-openbao.sh
#
# What this does:
#   1. Downloads the latest OpenBao binary (linux-amd64) if not already present
#   2. Starts OpenBao in dev mode (auto-unsealed, root token printed to stdout)
#   3. Enables Transit secrets engine
#   4. Creates Ed25519 signing key (oracle-price-signer)
#   5. Creates a scoped relay policy (sign + verify only — no export)
#   6. Creates a relay token with that policy
#   7. Writes credentials to relay/openbao-creds.json
#
# OpenBao is the open-source fork of HashiCorp Vault (MPL 2.0).
# HTTP API is 100% compatible with Vault — same endpoints, same headers.
# ─────────────────────────────────────────────────────────────────────────────

set -e

OPENBAO_VERSION="2.5.2"
WORKDIR="/tmp/openbao-oracle-demo"
BAO_BINARY="$WORKDIR/bao"
VAULT_ADDR="http://127.0.0.1:8200"
KEY_NAME="oracle-price-signer"

# Resolve the relay directory (parent of src/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RELAY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CREDS_FILE="$RELAY_DIR/openbao-creds.json"

GREEN="\033[0;32m"
YELLOW="\033[0;33m"
CYAN="\033[0;36m"
RED="\033[0;31m"
RESET="\033[0m"
BOLD="\033[1m"

echo ""
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  OpenBao Transit — Oracle V2 Demo Setup${RESET}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${RESET}"
echo ""
echo -e "  ${YELLOW}Using OpenBao (open-source Vault fork, MPL 2.0)${RESET}"
echo -e "  ${YELLOW}https://github.com/openbao/openbao${RESET}"
echo ""

# ─── Step 0: Check if server is already running ──────────────────────────────

if curl -sf "$VAULT_ADDR/v1/sys/health" > /dev/null 2>&1; then
  echo -e "  ${GREEN}✅ OpenBao already running on $VAULT_ADDR${RESET}"
  echo -e "  ${YELLOW}   (run teardown-openbao.sh first to restart)${RESET}"

  # If creds file exists, we're good
  if [ -f "$CREDS_FILE" ]; then
    echo -e "  ${GREEN}✅ Credentials file already exists: $CREDS_FILE${RESET}"
    echo ""
    echo -e "  ${GREEN}${BOLD}Setup already complete — ready to run demo!${RESET}"
    echo ""
    exit 0
  fi
fi

# ─── Step 1: Get bao binary ───────────────────────────────────────────────────

mkdir -p "$WORKDIR"

# Check if bao is already in PATH
if command -v bao &> /dev/null; then
  BAO_BINARY="$(which bao)"
  echo -e "  ${GREEN}✅ Found bao in PATH: $BAO_BINARY${RESET}"
elif [ -x "$BAO_BINARY" ]; then
  echo -e "  ${GREEN}✅ Found cached bao: $BAO_BINARY${RESET}"
else
  echo -e "  ${CYAN}[1/7] Downloading OpenBao v${OPENBAO_VERSION}...${RESET}"
  echo ""

  ARCHIVE="bao_${OPENBAO_VERSION}_Linux_x86_64.tar.gz"
  DOWNLOAD_URL="https://github.com/openbao/openbao/releases/download/v${OPENBAO_VERSION}/${ARCHIVE}"

  echo -e "  URL: $DOWNLOAD_URL"
  echo ""

  # Try curl first, then wget
  if command -v curl &> /dev/null; then
    curl -L --progress-bar -o "$WORKDIR/$ARCHIVE" "$DOWNLOAD_URL"
  elif command -v wget &> /dev/null; then
    wget -q --show-progress -O "$WORKDIR/$ARCHIVE" "$DOWNLOAD_URL"
  else
    echo -e "  ${RED}❌ Neither curl nor wget found. Install one and retry.${RESET}"
    exit 1
  fi

  echo ""
  echo -e "  Extracting..."
  tar -xzf "$WORKDIR/$ARCHIVE" -C "$WORKDIR"

  # The tarball extracts as 'bao'
  if [ ! -x "$BAO_BINARY" ]; then
    echo -e "  ${RED}❌ bao binary not found after extraction at $BAO_BINARY${RESET}"
    echo -e "  Contents of $WORKDIR:"
    ls -la "$WORKDIR/"
    exit 1
  fi

  chmod +x "$BAO_BINARY"
  echo -e "  ${GREEN}✅ OpenBao downloaded: $BAO_BINARY${RESET}"
fi

echo ""

# ─── Step 2: Start OpenBao in dev mode ────────────────────────────────────────

echo -e "  ${CYAN}[2/7] Starting OpenBao in dev mode...${RESET}"
echo ""

# Kill any stale bao process
pkill -f "bao server" 2>/dev/null || true
sleep 1

# Dev mode log file
BAO_LOG="$WORKDIR/bao-dev.log"
rm -f "$BAO_LOG"

# Start bao server in dev mode, capture output to log
# Dev mode: auto-init, auto-unseal, root token = "root" unless overridden
"$BAO_BINARY" server -dev -dev-root-token-id="oracle-demo-root-token" \
  -dev-listen-address="127.0.0.1:8200" \
  > "$BAO_LOG" 2>&1 &

BAO_PID=$!
echo -e "  ${YELLOW}OpenBao PID: $BAO_PID${RESET}"
echo -e "  ${YELLOW}Log: $BAO_LOG${RESET}"
echo ""

# Wait for server to be ready (up to 15 seconds)
RETRIES=30
echo -n "  Waiting for OpenBao to start"
for i in $(seq 1 $RETRIES); do
  if curl -sf "$VAULT_ADDR/v1/sys/health" > /dev/null 2>&1; then
    echo ""
    echo -e "  ${GREEN}✅ OpenBao is up and ready${RESET}"
    break
  fi
  echo -n "."
  sleep 0.5
  if [ $i -eq $RETRIES ]; then
    echo ""
    echo -e "  ${RED}❌ OpenBao failed to start after 15s${RESET}"
    echo -e "  Last 20 lines of log:"
    tail -20 "$BAO_LOG"
    exit 1
  fi
done

echo ""

# ─── Step 3: Configure Transit ────────────────────────────────────────────────

ROOT_TOKEN="oracle-demo-root-token"
export VAULT_ADDR="$VAULT_ADDR"
export VAULT_TOKEN="$ROOT_TOKEN"

echo -e "  ${CYAN}[3/7] Enabling Transit secrets engine...${RESET}"
"$BAO_BINARY" secrets enable transit 2>&1 | sed 's/^/    /'
echo ""

# ─── Step 4: Create Ed25519 signing key ───────────────────────────────────────

echo -e "  ${CYAN}[4/7] Creating Ed25519 signing key: $KEY_NAME...${RESET}"
"$BAO_BINARY" write -f transit/keys/$KEY_NAME type=ed25519 2>&1 | sed 's/^/    /'
echo ""

# Verify key was created
KEY_INFO=$("$BAO_BINARY" read -format=json transit/keys/$KEY_NAME 2>&1)
if echo "$KEY_INFO" | grep -q '"ed25519"'; then
  echo -e "  ${GREEN}✅ Ed25519 key created successfully${RESET}"
else
  echo -e "  ${YELLOW}  Key info: $KEY_INFO${RESET}"
fi
echo ""

# ─── Step 5: Create scoped relay policy ───────────────────────────────────────

echo -e "  ${CYAN}[5/7] Creating relay policy (sign + verify only)...${RESET}"

# Write policy HCL to temp file
POLICY_FILE="$WORKDIR/relay-policy.hcl"
cat > "$POLICY_FILE" <<'POLICY_EOF'
# Oracle Relay Policy — sign and verify only, no export
path "transit/sign/oracle-price-signer" {
  capabilities = ["update"]
}
path "transit/verify/oracle-price-signer" {
  capabilities = ["update"]
}
POLICY_EOF

"$BAO_BINARY" policy write oracle-relay "$POLICY_FILE" 2>&1 | sed 's/^/    /'
echo ""

# ─── Step 6: Create relay token ───────────────────────────────────────────────

echo -e "  ${CYAN}[6/7] Creating relay token with oracle-relay policy...${RESET}"

TOKEN_JSON=$("$BAO_BINARY" token create \
  -policy=oracle-relay \
  -display-name="oracle-relay" \
  -ttl=24h \
  -format=json 2>&1)

RELAY_TOKEN=$(echo "$TOKEN_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['auth']['client_token'])" 2>/dev/null)

if [ -z "$RELAY_TOKEN" ]; then
  echo -e "  ${RED}❌ Failed to create relay token${RESET}"
  echo "  Raw output: $TOKEN_JSON"
  exit 1
fi

echo -e "  ${GREEN}✅ Relay token created${RESET}"
echo ""

# ─── Step 7: Write credentials file ───────────────────────────────────────────

echo -e "  ${CYAN}[7/7] Writing credentials to $CREDS_FILE...${RESET}"

python3 - <<PYEOF
import json

creds = {
    "vault_addr": "$VAULT_ADDR",
    "root_token": "$ROOT_TOKEN",
    "relay_token": "$RELAY_TOKEN",
    "key_name": "$KEY_NAME",
    "pid": $BAO_PID,
    "binary": "$BAO_BINARY",
    "log": "$BAO_LOG",
    "backend": "openbao",
    "version": "$OPENBAO_VERSION"
}

with open("$CREDS_FILE", "w") as f:
    json.dump(creds, f, indent=2)
    f.write("\n")

print(f"  Written: $CREDS_FILE")
PYEOF

echo ""

# ─── Also create teardown script ──────────────────────────────────────────────

TEARDOWN_SCRIPT="$SCRIPT_DIR/teardown-openbao.sh"

cat > "$TEARDOWN_SCRIPT" <<'TEARDOWN_EOF'
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
TEARDOWN_EOF

chmod +x "$TEARDOWN_SCRIPT"
echo -e "  ${GREEN}✅ Created teardown script: $TEARDOWN_SCRIPT${RESET}"

# ─── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo -e "${CYAN}${BOLD}═══════════════════════════════════════════════════════════${RESET}"
echo -e "${GREEN}${BOLD}  ✅ OpenBao setup complete!${RESET}"
echo -e "${CYAN}═══════════════════════════════════════════════════════════${RESET}"
echo ""
echo -e "  Backend:     OpenBao v${OPENBAO_VERSION} (open-source Vault fork, MPL 2.0)"
echo -e "  Address:     $VAULT_ADDR"
echo -e "  Key:         $KEY_NAME (Ed25519, non-exportable)"
echo -e "  Token:       ${RELAY_TOKEN:0:20}... (sign+verify only)"
echo -e "  Credentials: $CREDS_FILE"
echo -e "  PID:         $BAO_PID"
echo ""
echo -e "  ${YELLOW}Run the demo:${RESET}"
echo -e "  ${BOLD}  cd relay && npx tsx src/demo.ts${RESET}"
echo ""
echo -e "  ${YELLOW}When done:${RESET}"
echo -e "  ${BOLD}  bash relay/src/teardown-openbao.sh${RESET}"
echo ""
