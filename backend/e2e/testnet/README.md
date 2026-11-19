# Stellar Testnet E2E suite

Live end-to-end checks against the public Stellar Testnet. Unlike the mocked
suites under `tests/`, these hit the real network to catch drift early:

| Suite | Detects |
| --- | --- |
| `network-health.e2e.test.ts` | RPC outages, passphrase/protocol changes, ledger close-time drift, RPC↔Horizon skew, fee surges, Friendbot regressions |
| `stream-lifecycle.e2e.test.ts` | Contract regressions on the live protocol (`create_stream` → `withdraw` → `cancel_stream`, `getEvents`) |
| `stream-lifecycle.e2e.test.ts` › indexer | Indexer drift — the real `SorobanEventWorker` must ingest those txs into Postgres with matching hashes, ledgers and amounts |

It is **not** part of `npm test`. It runs on a schedule (every 6h) via
`.github/workflows/testnet-e2e.yml`, which deploys a fresh contract from the
current `contracts/` source, runs the suite, and opens/updates a
`testnet-e2e-failure` issue when a scheduled run fails. It can also be run
manually from the Actions tab, optionally against an existing contract ID.

## Running locally

```bash
cd backend
# Network health only (no contract / DB needed):
npm run test:e2e:testnet -- network-health

# Full suite: deploy a contract, then point the suite at it and a Postgres DB
export E2E_STREAM_CONTRACT_ID=C...
export DATABASE_URL=postgresql://flowfi:flowfi_dev_password@127.0.0.1:5433/flowfi
npx prisma db push --schema=prisma/schema.prisma
npm run test:e2e:testnet
```

The indexer test **resets the `IndexerState` cursor** in the target database —
never point `DATABASE_URL` at a shared or production database.

Contract tests are skipped when `E2E_STREAM_CONTRACT_ID` is unset; indexer
tests are skipped when `DATABASE_URL` is unset.

## Configuration

| Variable | Default |
| --- | --- |
| `E2E_SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` |
| `E2E_HORIZON_URL` | `https://horizon-testnet.stellar.org` |
| `E2E_FRIENDBOT_URL` | `https://friendbot.stellar.org` |
| `E2E_NETWORK_PASSPHRASE` | Testnet passphrase |
| `E2E_STREAM_CONTRACT_ID` | _(unset → contract suites skipped)_ |
| `E2E_MAX_LEDGER_CLOSE_SECONDS` | `15` |
| `E2E_MAX_P90_INCLUSION_FEE` | `100000` stroops |
| `E2E_TX_TIMEOUT_MS` | `90000` |
| `E2E_INDEXER_TIMEOUT_MS` | `120000` |

## Network promotion & deployment manifest review

Promoting a contract or application version from **testnet** to **production**
requires a reviewed, machine-validated deployment manifest. Promotion is
**blocked** unless the manifest passes every check below.

### Manifest fields

| Field | Validated against |
| --- | --- |
| `network` | Target environment (`testnet` → `production`); must match the promotion target exactly |
| `contractId` | The deployed contract ID for the source environment |
| `artifactDigest` | SHA-256 digest of the built WASM/artifact being promoted |
| `schemaVersion` | Schema compatibility with the target environment's expected version |

### Validation rules

A promotion is rejected when any of the following hold:

- **Network mismatch** — `manifest.network` does not equal the promotion target
  (e.g. promoting a `testnet` manifest into `production`).
- **Contract ID mismatch** — `manifest.contractId` differs from the contract ID
  recorded for the source environment.
- **Artifact digest mismatch** — `manifest.artifactDigest` does not match the
  digest of the artifact being promoted (tampered or stale build).
- **Schema incompatibility** — `manifest.schemaVersion` is not compatible with
  the target environment's expected schema version.

Each rejection surfaces a clear, actionable error naming the offending field so
operators can correct the manifest before retrying.

### Approval responsibilities

- **Release author** — produces the manifest, ensures the artifact digest is
  computed from the exact build being promoted, and opens the promotion PR.
- **Reviewer (release owner)** — independently verifies the manifest fields
  against the source environment and approves the promotion. A reviewer must
  not approve their own manifest.
- **On-call operator** — confirms the target environment is healthy and that
  the schema version is compatible before the promotion is executed.

Promotion must never bypass manifest validation, wallet authorization, or
chain/network validation to force a release through.
