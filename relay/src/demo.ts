/**
 * Oracle V2 Demo — Full end-to-end demonstration
 *
 * 1. Load credentials from openbao-creds.json (auto-setup, dev mode)
 * 2. Fetch live prices (3 rounds, 5s apart)
 * 3. Sign each round via OpenBao Transit + verify
 * 4. Run security tests
 * 5. Print V1 vs V2 comparison table
 *
 * Using OpenBao (open-source Vault fork, MPL 2.0)
 * OpenBao dev mode is auto-initialized and auto-unsealed — no manual
 * unseal step needed. Run setup-openbao.sh first.
 */

import { readFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { TransitClient, VaultClient } from "./vault-client.js";
import { OracleRelay } from "./oracle-relay.js";
import { formatPrice } from "./price-fetcher.js";
import {
  runSecurityTests,
  printSecurityResults,
} from "./security-tests.js";

// ─── ANSI Colors ────────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const WHITE = "\x1b[37m";

// ─── Config ─────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const RELAY_DIR = resolve(__dirname, "..");

// Primary: openbao-creds.json (created by setup-openbao.sh)
const OPENBAO_CREDS_PATH = join(RELAY_DIR, "openbao-creds.json");

// Optional legacy fallback paths for an older Vault setup.
const LEGACY_INIT_KEYS_PATH = process.env.LEGACY_INIT_KEYS_PATH;
const LEGACY_RELAY_TOKEN_PATH = process.env.LEGACY_RELAY_TOKEN_PATH;

const VAULT_ADDR = "http://127.0.0.1:8200";
const TRANSIT_KEY_NAME = "oracle-price-signer";
const NUM_ROUNDS = 3;
const ROUND_DELAY_MS = 5000;

// ─── Helpers ────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function header(text: string): void {
  const line = "═".repeat(60);
  console.log(`\n${CYAN}${line}${RESET}`);
  console.log(`${BOLD}${WHITE}  ${text}${RESET}`);
  console.log(`${CYAN}${line}${RESET}\n`);
}

function section(step: string, title: string): void {
  console.log(`${BOLD}${YELLOW}[${step}]${RESET} ${BOLD}${title}${RESET}`);
}

function truncateSig(sig: string | null): string {
  if (!sig) return "null";
  // vault:v1:BASE64... → show first 20 chars of the base64 part
  const parts = sig.split(":");
  if (parts.length >= 3) {
    const b64 = parts.slice(2).join(":");
    return `${parts[0]}:${parts[1]}:${b64.substring(0, 16)}...`;
  }
  return sig.substring(0, 30) + "...";
}

interface LoadedCreds {
  vaultAddr: string;
  relayToken: string;
  keyName: string;
  isOpenBao: boolean;
  // Legacy Vault unseal keys (null in OpenBao dev mode — not needed)
  unsealKeys: string[] | null;
}

function loadCredentials(): LoadedCreds {
  // Try openbao-creds.json first
  if (existsSync(OPENBAO_CREDS_PATH)) {
    const creds = JSON.parse(readFileSync(OPENBAO_CREDS_PATH, "utf-8"));
    return {
      vaultAddr: creds.vault_addr || VAULT_ADDR,
      relayToken: creds.relay_token,
      keyName: creds.key_name || TRANSIT_KEY_NAME,
      isOpenBao: true,
      unsealKeys: null, // Dev mode — no unseal needed
    };
  }

  // Legacy fallback: old Vault init-keys.json + relay-token.txt
  if (
    LEGACY_INIT_KEYS_PATH &&
    LEGACY_RELAY_TOKEN_PATH &&
    existsSync(LEGACY_INIT_KEYS_PATH) &&
    existsSync(LEGACY_RELAY_TOKEN_PATH)
  ) {
    const initKeys = JSON.parse(readFileSync(LEGACY_INIT_KEYS_PATH, "utf-8"));
    const relayToken = readFileSync(LEGACY_RELAY_TOKEN_PATH, "utf-8").trim();
    return {
      vaultAddr: VAULT_ADDR,
      relayToken,
      keyName: TRANSIT_KEY_NAME,
      isOpenBao: false,
      unsealKeys: initKeys.unseal_keys_b64,
    };
  }

  // No credentials found
  const errMsg = [
    `No credentials found. Either:`,
    `  1. Run setup-openbao.sh to auto-configure OpenBao (recommended):`,
    `       bash relay/src/setup-openbao.sh`,
    `  2. Or use: ./run-demo.sh`,
    ``,
    `Expected: ${OPENBAO_CREDS_PATH}`,
  ].join("\n");

  throw new Error(errMsg);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  header("Oracle V2 Demo — OpenBao Transit Signing (TypeScript)");

  // ═══════════════════════════════════════════════════════════════════
  // Load credentials
  // ═══════════════════════════════════════════════════════════════════

  let creds: LoadedCreds;
  try {
    creds = loadCredentials();
  } catch (err: any) {
    console.error(`${RED}${err.message}${RESET}`);
    process.exit(1);
  }

  // Show backend info
  if (creds.isOpenBao) {
    console.log(
      `  ${GREEN}${BOLD}Using OpenBao (open-source Vault fork, MPL 2.0)${RESET}`
    );
    console.log(
      `  ${DIM}Dev mode: auto-initialized + auto-unsealed${RESET}`
    );
  } else {
    console.log(
      `  ${YELLOW}Using HashiCorp Vault (legacy mode)${RESET}`
    );
  }
  console.log();

  const vault = new TransitClient(creds.vaultAddr, creds.relayToken);

  // ═══════════════════════════════════════════════════════════════════
  // Step 1: Health check (and unseal if needed for legacy Vault)
  // ═══════════════════════════════════════════════════════════════════

  section("1/5", "Checking Transit backend...");

  const health = await vault.healthCheck();

  if (!health.initialized) {
    console.log(`  ${RED}❌ Backend is not initialized!${RESET}`);
    if (!creds.isOpenBao) {
      console.log(
        `  ${YELLOW}Hint: Run setup-openbao.sh for automatic setup${RESET}`
      );
    }
    process.exit(1);
  }

  if (health.sealed) {
    if (creds.isOpenBao) {
      // OpenBao dev mode should never be sealed
      console.log(
        `  ${RED}❌ OpenBao dev mode is sealed — this is unexpected${RESET}`
      );
      process.exit(1);
    }

    // Legacy Vault: unseal with Shamir keys
    if (!creds.unsealKeys || creds.unsealKeys.length === 0) {
      console.log(
        `  ${RED}❌ Vault is sealed but no unseal keys available${RESET}`
      );
      process.exit(1);
    }

    const keysToUse = creds.unsealKeys.slice(0, 3);
    const unsealed = await vault.unseal(keysToUse);

    if (!unsealed) {
      console.log(`  ${RED}❌ Failed to unseal Vault${RESET}`);
      process.exit(1);
    }
    console.log(
      `  ${GREEN}✅ Vault unsealed (3-of-5 Shamir shares)${RESET}`
    );
  } else {
    const backendName = creds.isOpenBao ? "OpenBao" : "Vault";
    console.log(
      `  ${GREEN}✅ ${backendName} ready${RESET} ${DIM}(v${health.version})${RESET}`
    );
  }

  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // Step 2 + 3: Fetch prices and sign (3 rounds)
  // ═══════════════════════════════════════════════════════════════════

  const relay = new OracleRelay(vault, creds.keyName);

  section("2/5", "Fetching live prices...");
  console.log();
  section("3/5", `Signing via OpenBao Transit (${NUM_ROUNDS} rounds)...`);
  console.log();

  for (let round = 1; round <= NUM_ROUNDS; round++) {
    const delayLabel = round === 1 ? "" : ` (+${ROUND_DELAY_MS / 1000}s)`;

    if (round > 1) {
      await sleep(ROUND_DELAY_MS);
    }

    console.log(`  ${BOLD}Round ${round}/${NUM_ROUNDS}${delayLabel}:${RESET}`);

    const result = await relay.executeRound(round);

    // Check if we got any signed prices
    const signedCount = result.prices.filter((p) => p.signature !== null).length;
    if (signedCount === 0 && round === 1) {
      console.log(
        `    ${DIM}(CoinGecko rate-limited — prices will appear on next round)${RESET}`
      );
    }

    // Print results for key assets
    for (const sp of result.prices) {
      if (sp.price === null) continue; // Skip unavailable assets

      const priceStr = formatPrice(sp.price);
      const sigStr = sp.signature
        ? `${GREEN}signed ✅${RESET} ${DIM}(sig: ${truncateSig(sp.signature)})${RESET}`
        : `${RED}skipped ❌${RESET}`;

      // Show deviation from last round if available
      let deltaStr = "";
      if (
        round > 1 &&
        sp.boundsCheck.deviation !== undefined &&
        sp.boundsCheck.deviation > 0
      ) {
        deltaStr = ` — Δ${(sp.boundsCheck.deviation * 100).toFixed(2)}% ${DIM}(within ±20% bounds)${RESET}`;
      }

      console.log(
        `    ${sp.asset.padEnd(8)} ${priceStr.padEnd(14)} ${sigStr}${deltaStr}`
      );
    }

    // Show simulated transaction
    if (round === 1) {
      console.log();
      console.log(`${DIM}${relay.simulateTransaction(result)}${RESET}`);
    }

    console.log();
  }

  // ═══════════════════════════════════════════════════════════════════
  // Step 4: Security Tests
  // ═══════════════════════════════════════════════════════════════════

  section("4/5", "Security Tests...");
  console.log();

  const securityResults = await runSecurityTests(
    vault,
    creds.keyName,
    creds.vaultAddr,
    creds.relayToken
  );

  printSecurityResults(securityResults);
  console.log();

  // ═══════════════════════════════════════════════════════════════════
  // Step 5: Comparison Table
  // ═══════════════════════════════════════════════════════════════════

  section("5/5", "Comparison: Current Oracle vs V2");
  console.log();

  const rows = [
    ["Key storage", "JSON files on disk", "Transit (HSM-backed)"],
    ["Key theft impact", "Permanent compromise", "Revoke token instantly"],
    ["Price validation", "DISABLED", "Active (±20% bounds)"],
    ["On-chain bounds", "None", "±20% from last valid"],
    ["On-chain median", "None", "Built-in (permissionless)"],
    ["Circuit breaker", "None", "Admin pause/resume"],
    ["Key rotation", "Redeploy program", "Admin set_updater()"],
    ["Staleness check", "Client-side only", "On-chain (30s max age)"],
    ["Updater mgmt", "Hard-coded pubkeys", "Dynamic (4 slots)"],
    ["Assets", "10 (same)", "10 (BTC→SILVER)"],
  ];

  const col1Width = 20;
  const col2Width = 22;
  const col3Width = 26;

  const h = (s: string, w: number) => s.padEnd(w);
  const border = (l: string, m: string, r: string, _f: string) =>
    `  ${l}${"─".repeat(col1Width + 2)}${m}${"─".repeat(col2Width + 2)}${m}${"─".repeat(col3Width + 2)}${r}`;

  console.log(border("┌", "┬", "┐", "─"));
  console.log(
    `  │ ${BOLD}${h("Feature", col1Width)}${RESET} │ ${h("Current (v1)", col2Width)} │ ${BOLD}${GREEN}${h("V2 (This Demo)", col3Width)}${RESET} │`
  );
  console.log(border("├", "┼", "┤", "─"));

  for (const [feature, v1, v2] of rows) {
    console.log(
      `  │ ${DIM}${h(feature, col1Width)}${RESET} │ ${h(v1, col2Width)} │ ${GREEN}${h(v2, col3Width)}${RESET} │`
    );
  }

  console.log(border("└", "┴", "┘", "─"));

  // ═══════════════════════════════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════════════════════════════

  console.log();
  const allSecPassed = securityResults.every((r) => r.passed);
  if (allSecPassed) {
    console.log(
      `${GREEN}${BOLD}  ✅ All systems nominal — Oracle V2 demo complete${RESET}`
    );
  } else {
    console.log(
      `${RED}${BOLD}  ⚠️  Some security tests failed — review above${RESET}`
    );
  }

  const backendLabel = creds.isOpenBao ? "OpenBao Transit" : "Vault Transit";
  console.log(
    `${DIM}  Backend: ${backendLabel} | Key: ${creds.keyName} | Rounds: ${NUM_ROUNDS}${RESET}`
  );
  if (creds.isOpenBao) {
    console.log(
      `${DIM}  Using OpenBao (open-source Vault fork, MPL 2.0) — https://openbao.org${RESET}`
    );
  }
  console.log();
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(`${RED}Fatal error: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
