/**
 * Oracle Relay — Main relay logic
 *
 * Fetches prices → validates → signs via Vault Transit → simulates
 * on-chain transaction. Does NOT submit real transactions.
 */

import { VaultClient } from "./vault-client.js";
import { fetchPrices, formatPrice, PriceRound, PriceData } from "./price-fetcher.js";
import { PriceValidator, ValidationResult } from "./price-validator.js";

export interface SignedPrice {
  asset: string;
  price: number | null;
  timestamp: number;
  signature: string | null;
  verified: boolean;
  boundsCheck: ValidationResult;
  stalenessCheck: ValidationResult;
}

export interface RelayRound {
  roundNumber: number;
  prices: SignedPrice[];
  timestamp: number;
}

export class OracleRelay {
  private vault: VaultClient;
  private validator: PriceValidator;
  private keyName: string;
  private lastPrices: Map<string, number> = new Map();

  constructor(vault: VaultClient, keyName: string) {
    this.vault = vault;
    this.validator = new PriceValidator();
    this.keyName = keyName;
  }

  /**
   * Execute one relay round: fetch → validate → sign → simulate.
   */
  async executeRound(roundNumber: number): Promise<RelayRound> {
    const priceRound = await fetchPrices();
    const signedPrices: SignedPrice[] = [];

    // Process each available asset
    const assets: [string, PriceData][] = [
      ["BTC", priceRound.btc],
      ["ETH", priceRound.eth],
      ["SOL", priceRound.sol],
      ["GOLD", priceRound.gold],
      ["SILVER", priceRound.silver],
      ["HYPE", priceRound.hype],
      ["ZEC", priceRound.zec],
      ["TSLA", priceRound.tsla],
      ["NVDA", priceRound.nvda],
      ["MSTR", priceRound.mstr],
    ];

    for (const [name, data] of assets) {
      const lastPrice = this.lastPrices.get(name) ?? 0;

      // Validate bounds
      const boundsCheck = data.price !== null
        ? this.validator.validateBounds(name, data.price, lastPrice)
        : { valid: false, reason: `${name}: No price data available` } as ValidationResult;

      // Validate staleness
      const stalenessCheck = this.validator.validateStaleness(data.timestamp);

      let signature: string | null = null;
      let verified = false;

      // Only sign if price is available and passes validation
      if (data.price !== null && boundsCheck.valid && stalenessCheck.valid) {
        try {
          // Build the message to sign: "asset:price:timestamp"
          const message = `${name}:${data.price}:${data.timestamp}`;
          const msgBuf = Buffer.from(message, "utf-8");

          signature = await this.vault.sign(this.keyName, msgBuf);
          verified = await this.vault.verify(this.keyName, msgBuf, signature);

          // Update last known price
          this.lastPrices.set(name, data.price);
        } catch (err: any) {
          signature = null;
          verified = false;
        }
      }

      signedPrices.push({
        asset: name,
        price: data.price,
        timestamp: data.timestamp,
        signature,
        verified,
        boundsCheck,
        stalenessCheck,
      });
    }

    return {
      roundNumber,
      prices: signedPrices,
      timestamp: Date.now(),
    };
  }

  /**
   * Build a simulated on-chain instruction payload for logging.
   * This is what WOULD be submitted to the Oracle V2 program.
   */
  simulateTransaction(round: RelayRound): string {
    const validPrices = round.prices.filter((p) => p.signature !== null);
    if (validPrices.length === 0) return "  (no valid prices to submit)";

    const lines: string[] = [];
    lines.push(`  Simulated batch_set_prices instruction:`);
    lines.push(`    program: OrcV2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`);
    lines.push(`    index: 1 (param1 — Vault-signed relay)`);
    lines.push(`    assets:`);

    for (const p of validPrices) {
      const priceInt = Math.round((p.price ?? 0) * 1e6); // 6 decimal
      lines.push(`      ${p.asset.padEnd(8)} → ${priceInt} (${formatPrice(p.price)})`);
    }

    lines.push(`    timestamp: ${round.timestamp}`);
    lines.push(`    ⚠️  SIMULATION ONLY — not submitted to chain`);

    return lines.join("\n");
  }

  /**
   * Get the last known prices for display.
   */
  getLastPrices(): Map<string, number> {
    return new Map(this.lastPrices);
  }

  /**
   * Inject a last known price (for bounds testing).
   */
  setLastPrice(asset: string, price: number): void {
    this.lastPrices.set(asset, price);
  }
}
