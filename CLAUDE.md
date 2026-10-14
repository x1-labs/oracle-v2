# CLAUDE.md

This file provides guidance to coding agents working in the Oracle V2
repository. `AGENTS.md` contains the mandatory safety and approval rules.

## Project overview

Oracle V2 is an X1/Solana price-oracle repository with on-chain Anchor
programs, OpenBao-backed TypeScript relays, a multi-source Python price feed,
and a browser dashboard.

The project is currently inactive. Its deployed program accounts and state
PDAs remain on X1 mainnet, but maintainers confirm that neither program is in
use. Treat all production deployment material as a reactivation plan requiring
an explicit new product decision; see `README.md` for the dated RPC evidence.

It is a small polyglot monorepo. Both Anchor programs are members of the root
Cargo workspace, both Node packages are npm workspaces under one lockfile, and
the root commands and CI verify the Rust, TypeScript, Python, and container
boundaries together.

There are two distinct on-chain implementations:

- `programs/oracle-v2/` is the original updater-authorized oracle with price
  bounds, median calculation, a circuit breaker, and dynamic updater slots. Its
  deployed X1 mainnet program ID is
  `9XQ8gvrBfkxpcfdXj3BF5XrorRGpdpQvoFibqHdyRei6`.
- `programs/oracle-vault/` is the newer OpenBao Transit design. Relays submit an
  Ed25519 precompile instruction followed by an Anchor instruction; the program
  verifies the signed message by inspecting the instructions sysvar. Its
  deployed X1 mainnet program ID is
  `9mPmjK8NxJadYDiHiYAQH4WFCnKJr7ZV8ria63ZkMtv2`.

Do not mix their account layouts, PDAs, instruction formats, IDs, or client
scripts. The root `README.md` primarily describes `oracle-vault`; `Anchor.toml`
contains the deployed IDs for both programs.

## Monorepo structure and direction

Keep the components in one repository: the on-chain verifier, signed-message
builders, relay, price feed, and dashboard evolve around the same protocol and
benefit from atomic changes. The remaining useful monorepo improvements are
shared golden vectors for Rust/TypeScript signed-message compatibility and a
local-validator integration harness. A heavy task runner is unnecessary until
caching or a larger package graph justifies it.

Preserve deployable units and their Docker/runtime boundaries even when their
development commands are unified at the repository root.

## Repository layout

```text
programs/oracle-v2/       Original Anchor oracle; Cargo workspace member
programs/oracle-vault/    OpenBao/Ed25519 Anchor oracle; Cargo workspace member
relay/                    Local OpenBao demonstration and security checks
relay-clients/            Production TypeScript relay and Docker Compose stack
price-feed/               Python HTTP price aggregation service on port 8281
dashboard/                Static dashboard and Docker-log SSE bridge
test-mainnet.ts           State-mutating oracle-v2 X1 mainnet integration script
oracle-v2-keypair.json    Sensitive deployed-program key material
```

## Data flow

1. `price-feed/price-feed.py` polls several public market-data sources.
2. A relay reads the aggregated prices and constructs the exact byte encoding
   expected by the selected on-chain program.
3. For `oracle-vault`, OpenBao Transit signs the message with Ed25519 without
   exposing the private key.
4. The relay submits an Ed25519 verification instruction and the oracle
   instruction in one transaction.
5. The program validates the instruction, signature metadata, bounds, and
   timestamp before updating its PDA.
6. Consumers read per-relay slots and median prices; the dashboard exposes
   operational state.

The signed-message format is a protocol boundary. Rust builders and TypeScript
serialization must remain byte-for-byte compatible.

## Development commands

Run commands from the repository root unless a different directory is shown.

### Root workspace checks

```bash
cargo metadata --no-deps
cargo fmt --all -- --check
cargo check --workspace
cargo test --workspace
npm ci --ignore-scripts
npm run check
```

The repository pins Rust 1.89 and Node 22. Use the root npm lockfile; do not add
workspace-local lockfiles.

### Local OpenBao relay demo

```bash
npm run typecheck --workspace=oracle-relay
npm run run-demo --workspace=oracle-relay
```

`run-demo` downloads and starts a local OpenBao dev server, writes
`relay/openbao-creds.json`, fetches public price data, runs the demo and
security checks, and normally tears the service down. Use
`npm run teardown` if cleanup is needed. Never commit the generated credentials
file. The local security suite requires the local OpenBao instance.

### Production relay client

```bash
npm run typecheck --workspace=oracle-relay-client
npm run build --workspace=oracle-relay-client
docker build -f relay-clients/Dockerfile .
```

Building is safe; starting the relay is not a local-only check. The client and
`docker-compose.yml` default to X1 mainnet and can continuously submit
transactions. `init-oracle.mjs` and `submit-test.mjs` also mutate mainnet and
must not be run without explicit production approval.

### Python services

```bash
python3 price-feed/price-feed.py

cd dashboard
python3 -m http.server 8280
python3 sse-bridge.py
```

The price feed listens on port 8281 and exposes `/healthz` and `/readyz`. The
SSE bridge listens on port 8282 and reads local Docker logs. These services use
external APIs or local Docker state but should not submit on-chain transactions
by themselves.

The vendor-neutral runtime and reactivation contract is in
`docs/deployment/runtime.md`. The dashboard is not currently safe or portable
enough for a public frontend because it assumes direct OpenBao and host-log
access.

## Configuration and generated state

- `Anchor.toml` selects X1 mainnet and a wallet under `~/.config/solana/`.
  Treat `anchor deploy` and provider-driven commands as production operations.
- `relay-clients/relay-client.ts` accepts `VAULT_ADDR`, `KEY_NAME`, `CLIENT_ID`,
  `INTERVAL`, `PRICE_FEED`, `KEYPAIR_PATH`, `RPC_URL`, `PROGRAM_ID`,
  `TRANSIT_PUBKEY`, and `CU_BUDGET`. Authentication uses either legacy
  `VAULT_TOKEN` or production `VAULT_ROLE_ID` plus `VAULT_SECRET_ID_FILE`; the
  two modes are mutually exclusive.
- Production relay defaults and Compose constants are duplicated. When an
  approved configuration change is made, search the whole repository and keep
  the program, scripts, dashboard, README, and Compose values consistent.
- Relay wallet files belong under ignored `keys/` directories. Local OpenBao
  credentials, tokens, `.env` files, and service logs are local-only state.

## Testing strategy

- Prefer pure/unit tests for serialization, bounds, staleness, median logic,
  and Ed25519 instruction parsing.
- Use a local validator and newly generated ephemeral wallets for transaction
  tests. Never repoint a test at a live RPC endpoint.
- Treat both copies of `test-mainnet.ts`, the relay submission script,
  initialization script, Docker relay stack, and deployment commands as manual
  production operations rather than automated tests.
- For protocol changes, test both the Rust verifier and the TypeScript message
  builder with shared golden vectors.
- For security or operational changes, follow the explicit approval and
  end-to-end hand-test requirements in `AGENTS.md`.

## Code conventions

- Rust: follow Anchor conventions, keep arithmetic checked, validate account
  ownership and signer assumptions, and preserve stable error semantics.
- TypeScript: keep strict type checking, prefer `async`/`await`, validate all
  remote responses, and include actionable context in errors without logging
  secrets.
- Python: keep the price-feed failure-tolerant; one unavailable upstream should
  not silently poison the aggregate or crash the service.
- Comments should explain security invariants, protocol constraints, and why a
  non-obvious decision exists rather than restating the code.

## Before handing off a change

1. Review `git status` and the relevant diff; confirm no key, token, generated
   credential, build output, or unrelated file is included.
2. Run the smallest meaningful local checks for each touched component.
3. State exactly what was and was not tested.
4. For any live-network operation, stop and obtain the approval required by
   `AGENTS.md`; never infer it from a broader request.
