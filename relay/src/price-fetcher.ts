/**
 * Price Fetcher — pulls live prices from CoinGecko + X1 Oracle SSE
 */

import { execSync } from "child_process";

export interface PriceData {
  asset: string;
  price: number | null;
  timestamp: number; // Unix ms
  source: string;
}

export interface PriceRound {
  btc: PriceData;
  eth: PriceData;
  sol: PriceData;
  gold: PriceData;
  silver: PriceData;
  hype: PriceData;
  zec: PriceData;
  tsla: PriceData;
  nvda: PriceData;
  mstr: PriceData;
}

const COINGECKO_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,tether-gold&vs_currencies=usd";

/**
 * Try fetching GOLD/SILVER from X1 Oracle SSE stream (with timeout).
 * Returns partial data or null on failure.
 */
async function fetchFromX1Oracle(): Promise<{
  gold?: number;
  silver?: number;
} | null> {
  try {
    // Use curl with max-time to grab SSE data
    const raw = execSync(
      'curl -s --max-time 5 "https://oracle.x1.xyz/api/stream" 2>/dev/null || true',
      { encoding: "utf-8", timeout: 8000 }
    ).trim();

    if (!raw) return null;

    // Parse JSON lines — each line may be an SSE event
    const lines = raw.split("\n").filter((l) => l.startsWith("data:"));
    const result: { gold?: number; silver?: number } = {};

    for (const line of lines) {
      try {
        const json = JSON.parse(line.replace("data:", "").trim());
        // The SSE stream sends objects with asset names and prices
        if (json.gold) result.gold = Number(json.gold);
        if (json.silver) result.silver = Number(json.silver);
        if (json.GOLD) result.gold = Number(json.GOLD);
        if (json.SILVER) result.silver = Number(json.SILVER);
        // Also check nested "prices" object
        if (json.prices) {
          if (json.prices.gold) result.gold = Number(json.prices.gold);
          if (json.prices.silver)
            result.silver = Number(json.prices.silver);
          if (json.prices.GOLD) result.gold = Number(json.prices.GOLD);
          if (json.prices.SILVER)
            result.silver = Number(json.prices.SILVER);
        }
      } catch {
        // Skip unparseable lines
      }
    }

    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/**
 * Fetch live prices from CoinGecko free API.
 */
async function fetchFromCoinGecko(retries: number = 2): Promise<{
  btc?: number;
  eth?: number;
  sol?: number;
  gold?: number;
  silver?: number;
} | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
      const res = await fetch(COINGECKO_URL, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });

      if (res.status === 429) {
        // Rate limited — retry
        continue;
      }
      if (!res.ok) return null;

      const data = await res.json();
      return {
        btc: data.bitcoin?.usd ?? null,
        eth: data.ethereum?.usd ?? null,
        sol: data.solana?.usd ?? null,
        gold: data["tether-gold"]?.usd ?? null,
        // CoinGecko "silver" ID is a random crypto token, not the metal.
        // Silver metal isn't on their free tier. Omit it so the caller falls
        // back to the X1 oracle or the demo value.
      };
    } catch {
      if (attempt === retries) return null;
    }
  }
  return null;
}

function makePriceData(
  asset: string,
  price: number | null,
  source: string
): PriceData {
  return { asset, price, timestamp: Date.now(), source };
}

/**
 * Fetch a complete price round. Tries CoinGecko first, X1 Oracle SSE as
 * supplementary source for GOLD/SILVER.
 *
 * For assets not on CoinGecko (HYPE, ZEC, TSLA, NVDA, MSTR), uses
 * approximate/fallback values (demo mode — real relay would have proper feeds).
 */
export async function fetchPrices(): Promise<PriceRound> {
  const [cgData, x1Data] = await Promise.all([
    fetchFromCoinGecko(),
    fetchFromX1Oracle(),
  ]);

  const now = Date.now();

  // CoinGecko prices
  const btcPrice = cgData?.btc ?? null;
  const ethPrice = cgData?.eth ?? null;
  const solPrice = cgData?.sol ?? null;

  // GOLD/SILVER: prefer X1 oracle, fallback to CoinGecko
  const goldPrice = x1Data?.gold ?? cgData?.gold ?? null;
  const silverPrice = x1Data?.silver ?? cgData?.silver ?? null;
  const goldSource = x1Data?.gold ? "x1-oracle" : "coingecko";
  const silverSource = x1Data?.silver ? "x1-oracle" : "coingecko";

  // For assets not available via free APIs, use demo fallbacks with tiny
  // random jitter (±0.05%) to simulate realistic multi-round behavior.
  const jitter = () => 1 + (Math.random() - 0.5) * 0.001;

  // Silver: prefer X1 oracle, otherwise use approximate market price
  const silverFinal = silverPrice ?? +(33.50 * jitter()).toFixed(2);
  const silverSrc = silverPrice ? silverSource : "demo-fallback";

  return {
    btc: makePriceData("BTC", btcPrice, "coingecko"),
    eth: makePriceData("ETH", ethPrice, "coingecko"),
    sol: makePriceData("SOL", solPrice, "coingecko"),
    gold: makePriceData("GOLD", goldPrice, goldSource),
    silver: makePriceData("SILVER", silverFinal, silverSrc),
    // Assets not on CoinGecko free tier — use approximate demo values
    hype: makePriceData("HYPE", +(21.30 * jitter()).toFixed(2), "demo-fallback"),
    zec: makePriceData("ZEC", +(38.50 * jitter()).toFixed(2), "demo-fallback"),
    tsla: makePriceData("TSLA", +(268.00 * jitter()).toFixed(2), "demo-fallback"),
    nvda: makePriceData("NVDA", +(116.00 * jitter()).toFixed(2), "demo-fallback"),
    mstr: makePriceData("MSTR", +(330.00 * jitter()).toFixed(2), "demo-fallback"),
  };
}

/**
 * Format a price for display with comma separators.
 */
export function formatPrice(price: number | null): string {
  if (price === null) return "N/A";
  if (price >= 1000)
    return "$" + price.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (price >= 1)
    return "$" + price.toFixed(2);
  return "$" + price.toFixed(4);
}
