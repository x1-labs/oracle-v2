# Oracle V2 — OpenBao Transit Price Oracle

> [!IMPORTANT]
> **Project status: inactive.** The deployed program accounts and state PDAs
> remain on X1 mainnet, but the project maintainers confirm that neither oracle
> program is currently in use. A read-only RPC check on 2026-10-14 found the
> most recent observable transactions on 2026-03-24 for `oracle-v2` and
> 2026-03-27 for `oracle-vault`. Treat this repository as historical/reference
> code unless an explicit product decision reactivates it. Do not provision
> production infrastructure, start relays, or change on-chain state solely from
> this repository.

A reference implementation of an X1/Solana price oracle that uses **OpenBao Transit** (Ed25519 HSM-style signing) to authenticate price submissions on-chain.

This is a Cargo and npm monorepo. For safe root-level verification, use
`npm ci --ignore-scripts` followed by `npm run check`. The portable runtime,
security, and reactivation contract is documented in
[`docs/deployment/runtime.md`](docs/deployment/runtime.md).

## Architecture

```
Price Sources (Pyth + Coinbase + Kraken + MEXC + KuCoin)
    ↓ every 3s
Price Feed Server (:8281)
    ↓ every 10s
5 Docker Relay Clients (TypeScript, @solana/web3.js)
    ↓ sign via OpenBao Transit (Ed25519)
    ↓ Ed25519SigVerify precompile + batch_submit_prices
    ↓ submit to X1 RPC
Oracle Vault Program (on-chain, Anchor/Solana)
    → verifies Transit signature via Ed25519 precompile introspection
    → writes 6 asset prices × 5 relay slots to PDA
    → consumer dApps read median prices from PDA
```

### Key Design Decisions

- **Any wallet** can submit prices — authorization is via Transit Ed25519 signature, not wallet pubkey
- **OpenBao Transit** (open-source Vault fork, MPL 2.0) holds the signing key — relay clients never touch private keys
- **5 independent relays** submit prices every ~10 seconds with staggered timing
- **25,000 CU budget** per transaction (actual usage ~12,500 CU)
- **6 decimals** precision for all prices

## Components

### `programs/oracle-vault/` — On-Chain Program (Anchor/Solana)

The Solana program that stores and validates price submissions.

- Verifies Ed25519 signatures by introspecting the `Ed25519SigVerify` precompile instruction in the same transaction
- Stores prices in 5 relay slots per asset (6 assets × 5 slots = 30 price entries)
- Admin can rotate the oracle public key without redeploying

**Build from the repository root:**
```bash
cargo check --workspace
cargo test --workspace
```

**Deploy:**

This writes to X1 mainnet. Follow `AGENTS.md` and obtain explicit approval for
the exact program, authority, artifact, and transaction before running it.

```bash
solana program deploy target/deploy/oracle_vault.so --url https://rpc.mainnet.x1.xyz
```

### `relay/` — Original Demo Relay (Node.js)

The original demonstration relay that shows OpenBao Transit sign/verify flow. Good for understanding the concept.

### `relay-clients/` — Production Relay (TypeScript + Docker)

Production relay clients that fetch prices, sign via OpenBao Transit, and submit on-chain.

**Files:**
- `relay-client.ts` — TypeScript relay client with ComputeBudget limits
- `Dockerfile` — Multi-stage build (compile TS → slim runtime)
- `docker-compose.yml` — 5 relay containers with keypair mounts
- `init-oracle.mjs` — Initialize the on-chain PDA with Transit public key
- `submit-test.mjs` — Test single price submission

**Build from the repository root:**
```bash
npm ci --ignore-scripts
npm run build --workspace=oracle-relay-client
docker build -f relay-clients/Dockerfile -t oracle-relay:local .
```

Starting the Compose stack submits to X1 mainnet and requires explicit
production approval plus externally supplied OpenBao, RPC, price-feed, and
public-key configuration. It is not a local smoke test.

**Environment variables:**
| Variable | Default | Description |
|---|---|---|
| `CLIENT_ID` | required | Relay identifier (relay-1 through relay-5) |
| `VAULT_ADDR` | required | OpenBao address |
| `VAULT_TOKEN` | optional | Static OpenBao token for legacy/local operation; mutually exclusive with AppRole |
| `VAULT_ROLE_ID` | AppRole mode | OpenBao AppRole identifier |
| `VAULT_SECRET_ID_FILE` | AppRole mode | Path to the mounted OpenBao SecretID; never pass the SecretID directly in an environment variable |
| `KEY_NAME` | `oracle-price-signer` | Transit key name |
| `INTERVAL` | `10` | Seconds between submissions |
| `PRICE_FEED` | required | Price feed server URL |
| `KEYPAIR_PATH` | required | Path to relay wallet keypair JSON |
| `RPC_URL` | required | Solana/X1 RPC endpoint |
| `PROGRAM_ID` | deployed Oracle Vault ID | Oracle Vault program ID |
| `TRANSIT_PUBKEY` | required | Base64-encoded Transit Ed25519 public key |
| `CU_BUDGET` | `25000` | Compute unit budget per transaction |

Production relays use AppRole. The client logs in through
`/v1/auth/approle/login`, renews the leased token before expiry, and falls back
to re-authentication if renewal fails. Static `VAULT_TOKEN` support remains for
the local demo and legacy Compose operation only.

### `price-feed/` — Multi-Source Price Server

Python server that aggregates prices from 5 sources every 3 seconds.

**Sources:**
- Pyth Network (Hermes REST API, batched)
- Coinbase
- Kraken
- MEXC
- KuCoin

**Assets:** BTC, ETH, SOL, HYPE, ZEC, FARTCOIN + TSLA/NVDA/MSTR/GOLD/SILVER (via Pyth during market hours)

```bash
python3 price-feed/price-feed.py
# Serves on :8281
```

### `dashboard/` — Web Dashboard

Real-time monitoring dashboard with two tabs:

1. **Relay Clients** — Vault health, relay card controls, security tests, live Docker feed (SSE)
2. **On-Chain Program** — PDA state reader showing per-asset median prices and relay slot freshness

```bash
# Serve dashboard
cd dashboard
python3 -m http.server 8280

# Start SSE bridge (streams Docker logs to dashboard)
python3 sse-bridge.py
# Serves SSE on :8282
```

## OpenBao Setup

```bash
# Install OpenBao
curl -sL https://github.com/openbao/openbao/releases/download/v2.5.2/bao_2.5.2_linux_amd64.deb -o bao.deb
sudo dpkg -i bao.deb

# Initialize (3-of-5 Shamir)
bao operator init -key-shares=5 -key-threshold=3

# Enable Transit engine
bao secrets enable transit

# Create Ed25519 signing key
bao write transit/keys/oracle-price-signer type=ed25519 exportable=false

# Create scoped relay policy
bao policy write oracle-relay - <<EOF
path "transit/sign/oracle-price-signer" { capabilities = ["update"] }
path "transit/verify/oracle-price-signer" { capabilities = ["update"] }
EOF

# Create relay token
bao token create -policy=oracle-relay -period=720h
```

## Deployed Instances

### X1 Mainnet
- **Program:** `9mPmjK8NxJadYDiHiYAQH4WFCnKJr7ZV8ria63ZkMtv2`
- **State PDA:** `8XZBqbKhFXHqNGzxV3Tt6gEs9r8ZrNghsRg7zBwLMGJf`
- **Assets:** BTC (1), ETH (2), SOL (3), HYPE (4), ZEC (5), FARTCOIN (6)

## Security Model

1. **Transit key is non-exportable** — private key never leaves OpenBao
2. **Relay token is scoped** — can only sign and verify, not read/export keys
3. **On-chain verification** — program introspects Ed25519SigVerify precompile, cannot be spoofed
4. **Any wallet submits** — relay wallets only need XNT for fees, no privileged keys
5. **Admin-only key rotation** — oracle public key can be updated by program admin

## License

MIT
