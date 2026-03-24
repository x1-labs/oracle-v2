/**
 * Price Validator — local validation before submitting on-chain
 *
 * Mirrors the on-chain bounds check (±20%) and adds staleness detection
 * so the relay rejects bad data before wasting a transaction.
 */

export interface ValidationResult {
  valid: boolean;
  reason?: string;
  deviation?: number; // percentage
}

export class PriceValidator {
  /**
   * Check if newPrice is within ±maxDeviation of lastPrice.
   * maxDeviation is a fraction (0.20 = 20%).
   * Returns valid=true if within bounds, or if lastPrice is 0 (first update).
   */
  validateBounds(
    asset: string,
    newPrice: number,
    lastPrice: number,
    maxDeviation: number = 0.20
  ): ValidationResult {
    if (lastPrice === 0 || lastPrice === null) {
      return { valid: true, reason: "First update — no bounds check" };
    }

    if (newPrice <= 0) {
      return {
        valid: false,
        reason: `${asset}: Invalid price (${newPrice} <= 0)`,
        deviation: 0,
      };
    }

    const deviation = Math.abs(newPrice - lastPrice) / Math.abs(lastPrice);

    if (deviation > maxDeviation) {
      return {
        valid: false,
        reason: `${asset}: Price deviation ${(deviation * 100).toFixed(
          2
        )}% exceeds ±${(maxDeviation * 100).toFixed(0)}% (${lastPrice} → ${newPrice})`,
        deviation,
      };
    }

    return {
      valid: true,
      deviation,
    };
  }

  /**
   * Check if a timestamp is too old.
   * maxAgeMs defaults to 30000 (30 seconds) — matching on-chain staleness.
   */
  validateStaleness(
    timestampMs: number,
    maxAgeMs: number = 30_000
  ): ValidationResult {
    const ageMs = Date.now() - timestampMs;

    if (ageMs > maxAgeMs) {
      return {
        valid: false,
        reason: `Price is ${(ageMs / 1000).toFixed(1)}s old (max: ${(
          maxAgeMs / 1000
        ).toFixed(0)}s)`,
      };
    }

    return { valid: true };
  }

  /**
   * Compute the median of an array of prices, skipping nulls.
   * Returns null if no valid prices.
   */
  computeMedian(prices: (number | null)[]): number | null {
    const valid = prices.filter((p): p is number => p !== null && p > 0);
    if (valid.length === 0) return null;

    valid.sort((a, b) => a - b);
    const mid = Math.floor(valid.length / 2);

    if (valid.length % 2 === 0) {
      return (valid[mid - 1] + valid[mid]) / 2;
    }
    return valid[mid];
  }
}
