# FlowFi

[![codecov](https://codecov.io/gh/LabsCrypt/flowfi/branch/main/graph/badge.svg)](https://codecov.io/gh/LabsCrypt/flowfi)

**DeFi Payment Streaming on Stellar**

_Programmable, real-time payment streams and recurring subscriptions._

## Overview

FlowFi allows users to create continuous payment streams and recurring subscriptions using stablecoins on the Stellar network. By leveraging Soroban smart contracts, FlowFi enables autonomous accurate-to-the-second distribution of funds.

## Features

- **Real-time Streaming**: Pay by the second for services or salaries.
- **Recurring Subscriptions**: Automate monthly or weekly payments.
- **Soroban Powered**: Secure and efficient execution on Stellar's smart contract platform.

## Project Structure

```
flowfi/
├── backend/              # Express.js + TypeScript backend
├── contracts/            # Soroban smart contracts
│   ├── stream_contract/  # Core streaming logic
├── frontend/             # Next.js + Tailwind CSS frontend
├── docs/                 # Documentation
│   ├── ARCHITECTURE.md      # Architecture overview
│   ├── DEVELOPMENT.md       # Local development guide
│   └── TROUBLESHOOTING.md   # FAQ: wallet, Friendbot, Soroban RPC
```



For full step-by-step instructions, see our [Development Guide](docs/DEVELOPMENT.md).

### Prerequisites

- Node.js & npm
- Rust & Cargo
- Stellar CLI (optional but recommended)
- Docker & Docker Compose (for containerized setup)


## Architecture

FlowFi consists of three main components that work together:

- **Soroban Smart Contracts**: Handle on-chain payment stream logic.
- **Backend API**: Indexes on-chain events, provides REST API, and streams real-time updates via SSE
- **Frontend**: User interface for creating and managing payment streams

For a detailed explanation of how these components interact, where event indexing happens, and the overall system architecture, see the [Architecture Documentation](docs/ARCHITECTURE.md).

For full local setup and contributor onboarding, see the [Development Guide](docs/DEVELOPMENT.md).

## Getting Started

> **New here? Stuck on wallet setup?** See the [Troubleshooting & FAQ guide](docs/TROUBLESHOOTING.md) for switching Freighter between Testnet/Futurenet, funding test accounts with Stellar Friendbot, and resolving Soroban RPC rate-limit or simulation-timeout errors.

### Docker (Recommended)

The fastest way to run the full stack locally:

```bash
docker compose up --build
```

This starts:

- **Postgres** database on port `5433`
- **Backend** API on port `3001`

To run in detached mode:

```bash
docker compose up -d --build
```

To stop the services:

```bash
docker compose down
```

To reset the database:

```bash
docker compose down -v
```



### Frontend

```bash
cd frontend
npm install
npm run dev
```
### Backend (Manual)

```bash
cd backend
npm install
npm run dev
```

## Deployment

### Contract Deployment

The FlowFi smart contracts can be deployed to both testnet and mainnet using the automated deployment script.

#### Prerequisites

- Stellar CLI installed and configured
- Sufficient XLM in the deployment account for network fees
- Required environment variables set

#### Environment Variables

Before deploying, set the following environment variables:

```bash
export DEPLOYER_SECRET="your_secret_key_here"
export ADMIN_ADDRESS="your_admin_address_here"
export TREASURY_ADDRESS="your_treasury_address_here"
export FEE_RATE_BPS="25"  # 0.25% fee rate
```

#### Deploy to Testnet

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh --network testnet
```

#### Deploy to Mainnet

```bash
chmod +x scripts/deploy.sh
./scripts/deploy.sh --network mainnet
```

#### Deployment Process

The deployment script automates the following steps:

1. **Build WASM**: Compiles the Rust contract to WebAssembly
2. **Optimize WASM**: Optimizes the WASM for deployment size
3. **Deploy Contract**: Deploys the contract to the specified network
4. **Initialize Contract**: Sets up admin, treasury, and fee rate parameters
5. **Save Deployment Info**: Stores contract details in `deployment-info.json`

#### Deployment Information

After successful deployment, contract details are saved to `deployment-info.json`:

```json
{
  "testnet": {
    "network": "testnet",
    "contractId": "CD...ID",
    "deployedAt": "2024-01-01T00:00:00.000Z",
    "adminAddress": "G...ADMIN",
    "treasuryAddress": "G...TREASURY",
    "feeRateBps": 25,
    "transactionHash": "TX...HASH"
  },
  "mainnet": {
    "network": "mainnet",
    "contractId": "CD...ID",
    "deployedAt": "2024-01-01T00:00:00.000Z",
    "adminAddress": "G...ADMIN",
    "treasuryAddress": "G...TREASURY",
    "feeRateBps": 25,
    "transactionHash": "TX...HASH"
  },
  "lastUpdated": "2024-01-01T00:00:00.000Z"
}
```

#### Manual Deployment

If you prefer to deploy manually, you can use the Stellar CLI directly:

```bash
# Build and optimize
cd contracts
cargo build --target wasm32-unknown-unknown --release
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/stream_contract.wasm

# Deploy
stellar contract deploy --wasm target/wasm32-unknown-unknown/release/stream_contract.optimized.wasm --source YOUR_SECRET_KEY --network https://soroban-testnet.stellar.org

# Initialize
stellar contract invoke --id CONTRACT_ID --source YOUR_SECRET_KEY --network https://soroban-testnet.stellar.org initialize --admin ADMIN_ADDRESS --treasury TREASURY_ADDRESS --fee_rate_bps 25
```

## API Documentation

The FlowFi backend API uses URL-based versioning. All endpoints are prefixed with a version (e.g., `/v1/streams`).

- **Authentication**: [backend/docs/AUTHENTICATION.md](backend/docs/AUTHENTICATION.md)
- **API Versioning Guide**: [backend/docs/API_VERSIONING.md](backend/docs/API_VERSIONING.md)
- **Deprecation Policy**: [backend/docs/DEPRECATION_POLICY.md](backend/docs/DEPRECATION_POLICY.md)
- **Sandbox Mode**: [backend/docs/SANDBOX_MODE.md](backend/docs/SANDBOX_MODE.md) - Test without affecting production data
- **Interactive API Docs**: Available at `http://localhost:3001/api-docs` when backend is running
- **Raw OpenAPI JSON**: Available at `http://localhost:3001/api-docs.json` when backend is running

### Sandbox Mode

FlowFi supports sandbox mode for safe testing. Enable it by:

1. Setting `SANDBOX_MODE_ENABLED=true` in your `.env` file
2. Adding `X-Sandbox-Mode: true` header or `?sandbox=true` query parameter to requests

Sandbox mode uses a separate database and clearly labels all responses. See [Sandbox Mode Documentation](backend/docs/SANDBOX_MODE.md) for details.

## API Collections

Pre-built collections for exploring all endpoints without any manual setup.

| File | Client |
|---|---|
| [`docs/api/flowfi.postman_collection.json`](docs/api/flowfi.postman_collection.json) | Postman |
| [`docs/api/flowfi.hoppscotch_collection.json`](docs/api/flowfi.hoppscotch_collection.json) | Hoppscotch |

Environment files (import alongside the collection):

| File | Target |
|---|---|
| [`docs/api/local.postman_environment.json`](docs/api/local.postman_environment.json) | Postman — local |
| [`docs/api/test.postman_environment.json`](docs/api/test.postman_environment.json) | Postman — test |
| [`docs/api/local.hoppscotch_environment.json`](docs/api/local.hoppscotch_environment.json) | Hoppscotch — local |
| [`docs/api/test.hoppscotch_environment.json`](docs/api/test.hoppscotch_environment.json) | Hoppscotch — test |

### Quick start

**Postman**
1. *Import* → select `flowfi.postman_collection.json`.
2. *Import* → select the matching `*.postman_environment.json`.
3. Pick the environment from the top-right dropdown and send requests.

**Hoppscotch**
1. *Collections* → *Import / Export* → *Import from JSON* → select `flowfi.hoppscotch_collection.json`.
2. *Environments* → *Import* → select the matching `*.hoppscotch_environment.json`.
3. Activate the environment and send requests.

### SSE note

`GET /events/subscribe` streams `text/event-stream` data and keeps the connection open. Postman buffers the response — use *Send and Download* to capture it, or test interactively with:

```bash
curl -N --no-buffer 'http://localhost:3001/events/subscribe?all=true'
```

Or open `backend/test-sse-client.html` directly in a browser.

## Contributing

Contributions are welcome! Please see our [Contributing Guide](CONTRIBUTING.md) for:

- Local development setup instructions
- Code style and commit guidelines
- Pull request process
- Development scripts and CI workflows

Before your first change, run through the [Development Guide](docs/DEVELOPMENT.md) and review [Architecture Documentation](docs/ARCHITECTURE.md).

For architecture details, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Architecture Decisions & Threat Model (auditor entry points)

- **Architecture Decision Records:** [docs/adr/](docs/adr/) — TTL strategy, keeper-key deprecation, indexer cursor/dead-letter, SSE/WebSocket coexistence.
- **STRIDE Threat Model:** [docs/security/STRIDE_THREAT_MODEL.md](docs/security/STRIDE_THREAT_MODEL.md) — trust boundaries, threat matrix, mitigations, residual risks.
- **Batch Withdrawal Flow:** [docs/architecture/BATCH_WITHDRAWAL.md](docs/architecture/BATCH_WITHDRAWAL.md) — end-to-end sequence diagram for batch claims across frontend, SDK, contract, indexer, and SSE.
- **TypeScript SDK (client-side signing):** [packages/flowfi-sdk/](packages/flowfi-sdk/) — standalone `FlowFiClient` for direct ledger access without the backend API.
- **Preview environments:** every PR gets an ephemeral full-stack preview (migrated + seeded DB) via `.github/workflows/pr-preview.yml`; resources are torn down by `pr-preview-cleanup.yml` on close.
- **Troubleshooting & FAQ:** [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) — Freighter network switching, Friendbot funding, and Soroban RPC errors.

## Operations Runbook: Database Restore & Indexer Recovery

This runbook covers recovering the backend after data loss or corruption: restoring
PostgreSQL from a backup, verifying the indexer cursor, replaying chain events, and
avoiding serving inconsistent read models while recovery is in progress.

### Recovery objectives (assumptions)

These are the assumptions the restore exercise validates. Re-measure them after any
change to backup cadence, database size, or indexer throughput.

| Objective | Assumption | How it is measured |
|---|---|---|
| **RPO** (max data loss) | ≤ 5 minutes | Time between the last verified `pg_dump`/WAL checkpoint and the incident |
| **RTO** (max downtime) | ≤ 30 minutes | From "declare incident" to "API serving verified reads" |
| **Replay lag** | ≤ 2 minutes per 10k ledgers | `ledger_cursor` catch-up rate during replay |
| **Read-model staleness** | 0 inconsistent reads served | API returns `503`/`Retry-After` until checkpoint verified |

### 1. Backup procedure

Backups are logical dumps taken on a schedule (default every 5 minutes for the
`streams`, `events`, and `indexer_state` tables):

```bash
pg_dump --format=custom --no-owner --no-privileges \
  --file="flowfi-$(date -u +%Y%m%dT%H%M%SZ).dump" \
  "$DATABASE_URL"
```

Store dumps off-host with the same retention as your incident policy. Record the
dump's creation time and the highest ledger it contains — this is the restore
baseline used to compute RPO.

### 2. Restore procedure (isolated environment first)

Never restore directly over the production database. Restore into a scratch
database, verify it, then promote.

```bash
# 1. Create an empty target database
createdb flowfi_restore

# 2. Restore the dump
pg_restore --no-owner --no-privileges --clean --if-exists \
  --dbname=flowfi_restore flowfi-<timestamp>.dump

# 3. Run migrations to bring the schema to the current version
cd backend && npm run migrate

# 4. Verify the restored data (see section 3)
```

### 3. Cursor verification queries

Run these against the restored database before promoting it. Every query must
return the expected result; otherwise the restore is incomplete and must be
repeated from a later dump.

```sql
-- 3.1 Indexer cursor exists and is a sane ledger number
SELECT id, last_ledger, updated_at
FROM indexer_state
WHERE id = 'default';
-- Expect exactly one row, last_ledger > 0, updated_at recent.

-- 3.2 No gaps between the cursor and the newest indexed event
SELECT COUNT(*) AS missing
FROM generate_series(
  (SELECT last_ledger FROM indexer_state WHERE id = 'default'),
  (SELECT MAX(ledger) FROM events)
) AS g
WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.ledger = g);
-- Expect 0.

-- 3.3 Stream read model matches the event log
SELECT COUNT(*) AS mismatched
FROM streams s
WHERE s.last_event_ledger <> (
  SELECT MAX(e.ledger) FROM events e WHERE e.stream_id = s.id
);
-- Expect 0.

-- 3.4 No dead-letter events pending replay
SELECT COUNT(*) AS dead_letters FROM indexer_dead_letters;
-- Expect 0 before serving reads.
```

### 4. Chain replay

If the restored cursor is behind the chain tip (expected after any restore), replay
events from the cursor forward:

```bash
cd backend
# Replay from the verified cursor to the current chain tip
npm run indexer:replay -- --from-cursor --to-tip --batch-size 200
```

Replay is idempotent: events already present are skipped by `(tx_hash, event_index)`.
Monitor progress with:

```sql
SELECT last_ledger, updated_at FROM indexer_state WHERE id = 'default';
```

Stop replay and re-run section 3 if any verification query fails.

### 5. Read-model consistency safeguards

While a restore or replay is in progress, the API must not serve reads derived from
an unverified database. The backend enforces this with a recovery gate:

- On startup, the backend checks `indexer_state.recovery_complete`. If it is `false`,
  the API returns `503 Service Unavailable` with `Retry-After: 30` for all read
  endpoints (`/v1/streams*`, `/v1/events*`).
- The gate is cleared only after the section 3 verification queries pass and the
  operator marks recovery complete:

```sql
UPDATE indexer_state
SET recovery_complete = true, updated_at = NOW()
WHERE id = 'default';
```

- SSE subscribers receive a `recovery` event and are reconnected once the gate clears.
- Alternatively, serve reads from a verified checkpoint by pointing the API at the
  restored database only after section 3 passes (blue/green promotion).

### 6. Isolated restore exercise

Run this exercise quarterly (and before any major migration) in an isolated
environment. It is automated by `scripts/restore-exercise.sh` and covered by the
integration tests in `backend/tests/integration/restore-recovery.test.ts`.

```bash
# Spins up an ephemeral Postgres, seeds a known dataset, dumps it,
# restores into a scratch DB, runs the verification queries, and
# asserts RPO/RTO bounds.
./scripts/restore-exercise.sh
```

The exercise records:

- Measured RPO (time between seeded checkpoint and dump) and RTO (restore + verify).
- Pass/fail for each verification query in section 3.
- Replay catch-up rate against a simulated chain tip.

Record the results in the incident log. If measured RPO/RTO exceed the assumptions
in the table above, update the backup cadence or the runbook before the next release.

### 7. Rollout and operational impact

- The `recovery_complete` column is added by a migration; it defaults to `true` for
  existing rows so normal operation is unaffected.
- No public API interface changes: the only externally observable difference is the
  `503` + `Retry-After` response during recovery.
- Operators must have `pg_dump`/`pg_restore` access and permission to run the replay
  script. Document these in the on-call access matrix.

## Security

If you discover a security vulnerability, please see our [Security Policy](SECURITY.md) for information on how to report it responsibly.

## Community & Support

Review the discussions guide before opening an issue or looking for community support.

- **📖 [Discussions Guide](DISCUSSIONS.md)** - Learn when to use Discussions vs Issues.

## Contributors

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->
<!-- ALL-CONTRIBUTORS-LIST:END -->

This project follows the [all-contributors](https://github.com/all-contributors/all-contributors) specification. Contributions of any kind welcome!

## License

MIT.
