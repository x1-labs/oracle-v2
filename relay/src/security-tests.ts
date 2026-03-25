/**
 * Security Test Suite — validates Transit signing security properties
 *
 * Tests:
 * 1. Key export blocked (policy enforcement)
 * 2. Tamper detection (sign + modify data + verify → fail)
 * 3. Invalid token rejected
 * 4. Price bounds enforcement (>20% spike)
 * 5. Staleness detection (old timestamps)
 * 6. Backend version reported correctly (OpenBao vs Vault)
 */

import { readFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";
import { TransitClient, VaultClient } from "./vault-client.js";
import { PriceValidator } from "./price-validator.js";

// ANSI color codes
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

export async function runSecurityTests(
  vault: TransitClient,
  keyName: string,
  vaultAddr: string,
  token: string
): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const validator = new PriceValidator();

  // ─── Test 1: Key Export Blocked ────────────────────────────────────

  try {
    await vault.exportKey(keyName);
    results.push({
      name: "Key export blocked",
      passed: false,
      detail: "CRITICAL: Export succeeded — policy is misconfigured!",
    });
  } catch (err: any) {
    const msg = err.message || "";
    const isBlocked =
      msg.includes("403") ||
      msg.includes("400") ||
      msg.includes("blocked") ||
      msg.includes("permission denied");
    results.push({
      name: "Key export blocked",
      passed: isBlocked,
      detail: isBlocked
        ? `403 Forbidden — key material stays in Transit`
        : `Unexpected error: ${msg}`,
    });
  }

  // ─── Test 2: Tamper Detection ─────────────────────────────────────

  try {
    const original = Buffer.from("BTC:87234.56:1711234567890", "utf-8");
    const signature = await vault.sign(keyName, original);

    // Tamper with the data (change price)
    const tampered = Buffer.from("BTC:99999.99:1711234567890", "utf-8");
    const valid = await vault.verify(keyName, tampered, signature);

    results.push({
      name: "Tamper detection working",
      passed: !valid,
      detail: !valid
        ? "Tampered data correctly rejected by Transit"
        : "CRITICAL: Tampered data was accepted!",
    });
  } catch (err: any) {
    results.push({
      name: "Tamper detection working",
      passed: false,
      detail: `Error during tamper test: ${err.message}`,
    });
  }

  // ─── Test 3: Invalid Token Rejected ───────────────────────────────

  try {
    await vault.signWithToken(
      keyName,
      Buffer.from("test-data", "utf-8"),
      "hvs.FAKE_TOKEN_THAT_DOES_NOT_EXIST_12345"
    );

    results.push({
      name: "Invalid token rejected",
      passed: false,
      detail: "CRITICAL: Fake token was accepted!",
    });
  } catch (err: any) {
    const msg = err.message || "";
    const rejected =
      msg.includes("403") ||
      msg.includes("400") ||
      msg.includes("permission denied") ||
      msg.includes("missing client token");
    results.push({
      name: "Invalid token rejected",
      passed: rejected,
      detail: rejected
        ? "Fake token correctly rejected"
        : `Unexpected error: ${msg}`,
    });
  }

  // ─── Test 4: Price Bounds Enforcement ─────────────────────────────

  {
    // Simulate a >20% spike: BTC was $87,000 and suddenly jumps to $110,000
    const lastPrice = 87000;
    const spikePrice = 110000; // ~26.4% jump
    const result = validator.validateBounds("BTC", spikePrice, lastPrice);

    results.push({
      name: "Price bounds enforced (>20% rejected)",
      passed: !result.valid,
      detail: !result.valid
        ? `${(result.deviation! * 100).toFixed(1)}% spike correctly rejected (limit: ±20%)`
        : "CRITICAL: 26% spike was accepted!",
    });
  }

  // ─── Test 5: Staleness Detection ──────────────────────────────────

  {
    // Timestamp from 60 seconds ago — should be flagged
    const staleTs = Date.now() - 60_000;
    const result = validator.validateStaleness(staleTs, 30_000);

    results.push({
      name: "Staleness detection working",
      passed: !result.valid,
      detail: !result.valid
        ? `60s-old price correctly flagged as stale (limit: 30s)`
        : "CRITICAL: Stale price was accepted!",
    });
  }

  // ─── Test 6: Backend Version Check ────────────────────────────────

  try {
    const health = await vault.healthCheck();
    const version = health.version || "unknown";
    const backendType = await vault.backend();

    // Version should be a non-empty semver string, not "unknown"
    const versionLooksValid =
      version !== "unknown" &&
      version.length > 0 &&
      /^\d+\.\d+/.test(version);

    results.push({
      name: "Backend version reported correctly",
      passed: versionLooksValid,
      detail: versionLooksValid
        ? `${backendType} v${version} — version string is valid`
        : `Version reported as "${version}" — unexpected format`,
    });
  } catch (err: any) {
    results.push({
      name: "Backend version reported correctly",
      passed: false,
      detail: `Health check failed: ${err.message}`,
    });
  }

  return results;
}

/**
 * Print security test results with color.
 */
export function printSecurityResults(results: TestResult[]): void {
  const passed = results.filter((r) => r.passed).length;

  for (const r of results) {
    const icon = r.passed ? `${GREEN}✅` : `${RED}❌`;
    console.log(`  ${icon} ${r.name}${RESET} (${r.detail})`);
  }

  const allPassed = passed === results.length;
  const color = allPassed ? GREEN : RED;
  console.log(`  ${color}${passed}/${results.length} passed${RESET}`);
}

// ─── Standalone execution ───────────────────────────────────────────────────

if (
  process.argv[1]?.endsWith("security-tests.ts") ||
  process.argv[1]?.endsWith("security-tests.js")
) {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const RELAY_DIR = resolve(__dirname, "..");

  const OPENBAO_CREDS_PATH = join(RELAY_DIR, "openbao-creds.json");
  const LEGACY_TOKEN_PATH = "/home/jack/vault-test/relay-token.txt";

  let token: string;
  let vaultAddr = "http://127.0.0.1:8200";

  if (existsSync(OPENBAO_CREDS_PATH)) {
    const creds = JSON.parse(readFileSync(OPENBAO_CREDS_PATH, "utf-8"));
    token = creds.relay_token;
    vaultAddr = creds.vault_addr || vaultAddr;
  } else if (existsSync(LEGACY_TOKEN_PATH)) {
    token = readFileSync(LEGACY_TOKEN_PATH, "utf-8").trim();
  } else {
    console.error(
      "No credentials found. Run: bash relay/src/setup-openbao.sh"
    );
    process.exit(1);
  }

  const vault = new TransitClient(vaultAddr, token);
  const keyName = "oracle-price-signer";

  console.log("\n🔒 Oracle V2 — Security Test Suite\n");

  // Check if sealed first (shouldn't happen in OpenBao dev mode)
  vault.healthCheck().then(async (health) => {
    if (health.sealed) {
      console.log(
        "⚠️  Backend is sealed — run setup-openbao.sh to restart."
      );
      process.exit(1);
    }

    const results = await runSecurityTests(vault, keyName, vaultAddr, token);
    printSecurityResults(results);
    process.exit(results.every((r) => r.passed) ? 0 : 1);
  });
}
