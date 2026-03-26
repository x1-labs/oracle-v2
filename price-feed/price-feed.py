#!/usr/bin/env python3
"""
Oracle Price Feed Server — matches oracle repo sources:
  1. Pyth Network (Hermes REST API) — BTC, ETH, SOL, ZEC, TSLA, NVDA, MSTR, GOLD, SILVER
  2. CEX REST APIs — Kraken, Coinbase, Binance, Bybit, KuCoin, MEXC
  3. Assets: BTC, ETH, SOL, HYPE, ZEC, TSLA, NVDA, MSTR, GOLD, SILVER, FARTCOIN

Port: 8281 — updates every 3 seconds
"""

import json
import time
import threading
import urllib.request
from http.server import HTTPServer, BaseHTTPRequestHandler

INTERVAL = 3

# ─── Pyth Price Feed IDs (Hermes) ───────────────────────────────────────
PYTH_IDS = {
    "BTC":    "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    "ETH":    "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    "SOL":    "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    "ZEC":    "0xbe9b59d178f0d6a97ab4c343bff2aa69caa1eacd3d5d7571a9a7c5818ec1596d",
    "TSLA":   "0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
    "NVDA":   "0x20a938f54b68f1f2ef18ea0328f6dd0747f8ea11486d22b021e83a900be89776",
    "MSTR":   "0x593187b3072905d64b6cef3b316e6e88d7bb4ee6598dae55ab02e96fc0a9db80",
    "GOLD":   "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8524b43c6db",
    "SILVER": "0xf2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e",
    "FARTCOIN": "0x58cd29ef0e714c5affc44f32e17a2ab3ef5abe23c7a73ba244500e12d2dff4e0",
}

# ─── CEX Pair Configs (matches composite-client.ts) ─────────────────────
CEX_CONFIGS = {
    "BTC": {"kraken": "XXBTZUSD", "coinbase": "BTC-USD", "binance": "BTCUSDT", "bybit": "BTCUSDT", "kucoin": "BTC-USDT", "mexc": "BTCUSDT"},
    "ETH": {"kraken": "XETHZUSD", "coinbase": "ETH-USD", "binance": "ETHUSDT", "bybit": "ETHUSDT", "kucoin": "ETH-USDT", "mexc": "ETHUSDT"},
    "SOL": {"kraken": "SOLUSD",   "coinbase": "SOL-USD", "binance": "SOLUSDT", "bybit": "SOLUSDT", "kucoin": "SOL-USDT", "mexc": "SOLUSDT"},
    "HYPE": {"kraken": "HYPEUSD", "coinbase": "HYPE-USD", "binance": "HYPEUSDT", "bybit": "HYPEUSDT", "kucoin": "HYPE-USDT", "mexc": "HYPEUSDT"},
    "ZEC": {"coinbase": "ZEC-USD", "binance": "ZECUSDT", "kucoin": "ZEC-USDT", "mexc": "ZECUSDT"},
    "FARTCOIN": {"kraken": "FARTCOINUSD", "coinbase": "FARTCOIN-USD", "binance": "FARTCOINUSDT", "bybit": "FARTCOINUSDT", "kucoin": "FARTCOIN-USDT", "mexc": "FARTCOINUSDT"},
}

ALL_ASSETS = list(set(list(PYTH_IDS.keys()) + list(CEX_CONFIGS.keys())))
ALL_ASSETS.sort()

price_cache = {"prices": {}, "timestamp": 0, "sources": {}, "update_count": 0, "errors": [], "assets": ALL_ASSETS}
lock = threading.Lock()

# ─── Pyth Hermes API ────────────────────────────────────────────────────
def fetch_pyth():
    """Fetch from Pyth Hermes API — batch 3 IDs per request to avoid 403s."""
    results = {}
    id_to_sym = {v.replace("0x",""): k for k, v in PYTH_IDS.items()}
    ids = list(PYTH_IDS.values())
    # Batch into groups of 3
    for i in range(0, len(ids), 3):
        batch = ids[i:i+3]
        params = "&".join(f"ids[]={v}" for v in batch)
        url = f"https://hermes.pyth.network/v2/updates/price/latest?{params}"
        req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "OracleRelay/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=8) as resp:
                data = json.loads(resp.read())
                for entry in data.get("parsed", []):
                    feed_id = entry.get("id", "")
                    sym = id_to_sym.get(feed_id)
                    if not sym:
                        continue
                    price_obj = entry.get("price", {})
                    price_val = int(price_obj.get("price", 0))
                    expo = int(price_obj.get("expo", 0))
                    if price_val:
                        results[sym] = {"price": price_val * (10 ** expo), "source": "pyth"}
        except:
            pass
        time.sleep(0.2)  # Small delay between batches
    return results

# ─── CEX REST APIs ──────────────────────────────────────────────────────
def fetch_mexc():
    results = {}
    for asset, cfg in CEX_CONFIGS.items():
        if "mexc" not in cfg:
            continue
        url = f'https://api.mexc.com/api/v3/ticker/price?symbol={cfg["mexc"]}'
        req = urllib.request.Request(url, headers={"User-Agent": "OracleRelay/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
                if data.get("price"):
                    results[asset] = {"price": float(data["price"]), "source": "mexc"}
        except:
            pass
    return results

def fetch_coinbase():
    results = {}
    for asset, cfg in CEX_CONFIGS.items():
        if "coinbase" not in cfg:
            continue
        url = f'https://api.coinbase.com/v2/prices/{cfg["coinbase"]}/spot'
        req = urllib.request.Request(url, headers={"User-Agent": "OracleRelay/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
                price = data.get("data", {}).get("amount")
                if price:
                    results[asset] = {"price": float(price), "source": "coinbase"}
        except:
            pass
    return results

def fetch_kraken():
    results = {}
    pairs = []
    pair_map = {}
    for asset, cfg in CEX_CONFIGS.items():
        if "kraken" in cfg:
            pairs.append(cfg["kraken"])
            pair_map[cfg["kraken"]] = asset
    url = f'https://api.kraken.com/0/public/Ticker?pair={",".join(pairs)}'
    req = urllib.request.Request(url, headers={"User-Agent": "OracleRelay/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
            result_data = data.get("result", {})
            for pair_key, ticker in result_data.items():
                # Kraken returns slightly different pair names
                for orig_pair, asset in pair_map.items():
                    if orig_pair in pair_key or pair_key.startswith(orig_pair[:3]):
                        last_price = ticker.get("c", [None])[0]
                        if last_price:
                            results[asset] = {"price": float(last_price), "source": "kraken"}
                        break
    except:
        pass
    return results

def fetch_kucoin():
    results = {}
    for asset, cfg in CEX_CONFIGS.items():
        if "kucoin" not in cfg:
            continue
        url = f'https://api.kucoin.com/api/v1/market/orderbook/level1?symbol={cfg["kucoin"]}'
        req = urllib.request.Request(url, headers={"User-Agent": "OracleRelay/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read())
                price = data.get("data", {}).get("price")
                if price:
                    results[asset] = {"price": float(price), "source": "kucoin"}
        except:
            pass
    return results

# ─── Aggregation ────────────────────────────────────────────────────────
def aggregate_all(pyth_data, cex_sources):
    combined = {}
    for sym in ALL_ASSETS:
        entries = []
        if sym in pyth_data:
            entries.append(("pyth", pyth_data[sym]["price"], 2.0))  # Pyth gets highest weight
        for cex_data in cex_sources:
            if sym in cex_data:
                entries.append((cex_data[sym]["source"], cex_data[sym]["price"], 1.0))
        if not entries:
            continue

        # Weighted median
        entries.sort(key=lambda x: x[1])
        total_w = sum(e[2] for e in entries)
        cum = 0
        price = entries[-1][1]
        for src, p, w in entries:
            cum += w
            if cum >= total_w / 2:
                price = p
                break

        sources = [e[0] for e in entries]
        combined[sym] = {
            "price": round(price, 8),
            "sources": sources,
            "confidence": min(len(entries) / 3.0, 1.0),
            "source_count": len(entries),
        }
    return combined

# ─── Main Loop ──────────────────────────────────────────────────────────
def price_loop():
    while True:
        try:
            pyth = fetch_pyth()
            mexc = fetch_mexc()
            coinbase = fetch_coinbase()
            kraken = fetch_kraken()
            kucoin = fetch_kucoin()

            agg = aggregate_all(pyth, [mexc, coinbase, kraken, kucoin])
            ts = int(time.time() * 1000)

            with lock:
                price_cache["prices"] = agg
                price_cache["timestamp"] = ts
                price_cache["sources"] = {
                    "pyth": len(pyth),
                    "mexc": len(mexc),
                    "coinbase": len(coinbase),
                    "kraken": len(kraken),
                    "kucoin": len(kucoin),
                }
                price_cache["update_count"] += 1
                price_cache["errors"] = []
        except Exception as e:
            with lock:
                price_cache["errors"].append(str(e))
        time.sleep(INTERVAL)

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        with lock:
            data = json.dumps(price_cache)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data.encode())

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, *args): pass

if __name__ == "__main__":
    t = threading.Thread(target=price_loop, daemon=True)
    t.start()
    print(f"Oracle Price Feed :8281 — {INTERVAL}s | Sources: Pyth + Coinbase + Kraken + MEXC + KuCoin")
    print(f"Assets: {', '.join(ALL_ASSETS)}")
    HTTPServer(("0.0.0.0", 8281), Handler).serve_forever()
