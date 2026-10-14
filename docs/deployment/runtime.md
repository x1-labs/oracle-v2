# Runtime and deployment contract

## Current status: inactive

The project maintainers confirm that neither oracle program is currently in
use. A read-only X1 mainnet RPC check on 2026-10-14 found that both executable
program accounts and both expected state PDAs still exist, but the newest
transaction in the address history was 2026-03-24 for `oracle-v2` and
2026-03-27 for `oracle-vault`.

This establishes that the programs were deployed and exercised historically,
but have no recent observable on-chain activity; it does not prove that nobody
reads the accounts off-chain. Treat the material below as a portable
reactivation contract. Do not provision production resources, enable image
publishing, rotate a key, or start a relay unless an explicit product decision
reactivates the oracle.

## Deployable units

| Unit | Artifact | Runtime contract |
| --- | --- | --- |
| Price feed | `price-feed/Dockerfile` | Listens on port 8281, exposes `/healthz` and `/readyz`, and needs outbound HTTPS to its public data providers. |
| Relay | `relay-clients/Dockerfile` | Runs one relay identity, reads the price feed, signs through OpenBao Transit, and submits transactions to the configured RPC endpoint. It does not expose an HTTP service. |
| On-chain programs | Cargo workspace | Built and deployed independently from the containers. Program deployment and upgrades are explicit production operations. |
| Dashboard | Static files plus an SSE bridge | Assumes direct OpenBao and container-log access and is not suitable for a public frontend without redesign around a read-only status API. |

The relay and price-feed images are independent release artifacts. Build both
from the repository root so the root lockfile and ignore rules apply:

```bash
docker build -f relay-clients/Dockerfile -t oracle-v2-relay .
docker build -f price-feed/Dockerfile -t oracle-v2-price-feed .
```

## Configuration and secrets

The relay configuration contract is documented in the root `README.md`.
Production operators should:

- inject configuration at runtime instead of baking it into an image;
- give each relay a distinct fee-payer wallet and workload identity;
- mount wallet JSON and the OpenBao AppRole SecretID from a secret manager;
- keep the AppRole RoleID in ordinary configuration and the SecretID in a
  read-only file;
- restrict the AppRole policy to signing with one oracle-specific Transit key;
- keep TLS verification enabled for OpenBao and narrowly restrict network
  access to the price feed, OpenBao, the RPC endpoint, and required public data
  providers; and
- keep the price feed private to the relay workloads.

Static `VAULT_TOKEN` authentication remains available for local and legacy
operation. AppRole is the production-oriented mode: the client logs in using
`VAULT_ROLE_ID` and `VAULT_SECRET_ID_FILE`, caches the leased token, renews it,
and reauthenticates after an authentication failure.

Never store wallet JSON, OpenBao credentials, tokens, recovery material, or TLS
private keys in Git, image layers, Compose files, or deployment values.

## Key boundaries

The program keypair, program upgrade authority, OpenBao Transit key, and relay
fee-payer wallets are separate credentials:

- A program keypair determines the program ID.
- The upgrade authority controls future program upgrades.
- The Transit key signs oracle price messages; its public key is stored in the
  oracle state PDA.
- Relay wallets pay transaction fees and identify individual submitters.

OpenBao does not replace the program keypair or upgrade authority. The Transit
key should be non-exportable. If a deployment cannot retain an existing
Transit key, reactivation requires an explicitly approved on-chain key rotation
with a tested rollback plan.

`oracle-v2-keypair.json` is intentionally not tracked. Preserve any required
copy in approved offline custody. Because a copy appeared in prior public Git
history, treat that historical private key as exposed even after it disappears
from the current tree.

## Operational requirements

A production deployment should provide:

- immutable image references and a reviewed promotion path;
- non-root containers with CPU and memory requests and limits;
- price-feed liveness and readiness probes;
- independent relay identities and staggered submission intervals;
- disruption controls that avoid stopping every relay at once;
- restrictive ingress and egress policies;
- centralized logs and metrics; and
- alerts for stale prices, missing successful submissions, RPC failures,
  OpenBao unavailability, and low fee-payer balances.

## Reactivation checklist

Before any production rollout:

1. Confirm the consumers, supported assets, freshness requirements, and owner.
2. Audit the on-chain program and client protocol against the deployed state.
3. Confirm custody of the program upgrade authority and required program
   identity material.
4. Create or select an oracle-specific non-exportable Transit key and verify
   its public key against the program state.
5. Exercise AppRole login, renewal, Transit signing, and the exact signed
   message format in a representative non-production environment.
6. Deploy relays with transaction submission disabled and verify price
   freshness, RPC reachability, credentials, and fee-payer balances.
7. Obtain explicit approval for any required on-chain key or authority change.
8. Enable one relay, verify a successful update and resulting state, then
   enable the remaining relays gradually.
9. Define and observe rollback criteria before retiring any prior deployment.

The repository CI builds both images but does not publish or deploy them. Image
publication, environment-specific manifests, secret references, network policy,
and promotion automation belong in the operator's private deployment system.
