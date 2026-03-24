# Oracle V2 — Secure Price Feed for X1

On-chain Anchor program with hardened security + TypeScript off-chain relay using HashiCorp Vault Transit for signing.

**Deployed on X1 Mainnet:** `9XQ8gvrBfkxpcfdXj3BF5XrorRGpdpQvoFibqHdyRei6`

**Documentation:** https://oracle-v2-flow.vercel.app

## Features (vs V1)

| Feature | V1 (Current) | V2 (This) |
|---------|-------------|-----------|
| Key storage | JSON files on disk | Vault Transit (non-exportable) |
| Key theft impact | Permanent compromise | Revoke token instantly |
| Price validation | DISABLED | Active (±20% bounds) |
| On-chain bounds | None | ±20% from last price |
| On-chain median | None | Built-in permissionless |
| Circuit breaker | None | Admin pause/resume |
| Key rotation | Redeploy program | Admin instruction |
| Staleness | Client-side only | On-chain (30s threshold) |

## Structure

```
programs/oracle-v2/src/lib.rs   — Anchor on-chain program (Rust)
relay/src/                       — TypeScript relay with Vault Transit signing
  vault-client.ts                — Vault HTTP client (unseal, sign, verify)
  price-fetcher.ts               — CoinGecko + X1 Oracle SSE
  price-validator.ts             — Local bounds + staleness + median
  oracle-relay.ts                — Full relay loop
  security-tests.ts              — 5 security tests
  demo.ts                        — End-to-end demo entry point
test-mainnet.ts                  — X1 mainnet integration test
```

## Quick Start

```bash
# Run the Vault + relay demo
cd relay && npm install && npx tsx src/demo.ts

# Run mainnet integration test (requires funded wallet + deployed program)
cd relay && npx tsx test-mainnet.ts
```

## Vault Setup

Requires HashiCorp Vault with:
- Transit secrets engine enabled
- Ed25519 signing key (`oracle-price-signer`)
- Scoped relay token (sign-only policy)
- 3-of-5 Shamir seal

## 10 Assets

BTC, ETH, SOL, HYPE, ZEC, TSLA, NVDA, MSTR, GOLD, SILVER
