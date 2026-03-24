/**
 * Security Test Suite — validates Vault Transit security properties
 *
 * Tests:
 * 1. Key export blocked (policy enforcement)
 * 2. Tamper detection (sign + modify data + verify → fail)
 * 3. Invalid token rejection
 * 4. Price bounds enforcement (>20% spike)
 * 5. Staleness detection (old timestamps)
 */

import { VaultClient } from "./vault-client.js";
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
  vault: VaultClient,
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
      msg.includes("403") || msg.includes("400") || msg.includes("blocked") || msg.includes("permission denied");
    results.push({
      name: "Key export blocked",
      passed: isBlocked,
      detail: isBlocked
        ? `403 Forbidden — key material stays in Vault`
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
        ? "Tampered data correctly rejected by Vault"
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
      msg.includes("403") || msg.includes("400") || msg.includes("permission denied") || msg.includes("missing client token");
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

if (process.argv[1]?.endsWith("security-tests.ts") ||
    process.argv[1]?.endsWith("security-tests.js")) {
  import("fs").then(async (fs) => {
    const token = fs
      .readFileSync("/home/jack/vault-test/relay-token.txt", "utf-8")
      .trim();
    const vault = new VaultClient("http://127.0.0.1:8200", token);
    const keyName = "oracle-price-signer";

    console.log("\n🔒 Oracle V2 — Security Test Suite\n");

    // Check if vault is sealed first
    const health = await vault.healthCheck();
    if (health.sealed) {
      console.log("⚠️  Vault is sealed — unseal first before running security tests.");
      process.exit(1);
    }

    const results = await runSecurityTests(
      vault,
      keyName,
      "http://127.0.0.1:8200",
      token
    );
    printSecurityResults(results);
    process.exit(results.every((r) => r.passed) ? 0 : 1);
  });
}
