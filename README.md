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

## Clean-Clone Verification

A fully scripted path from a fresh clone to a verified local stack. Every command below is exercised by the verification script, which is also run in CI (see [`.github/workflows/`](.github/workflows/)) and can be run periodically by maintainers.

### One-shot script

```bash
# From a fresh clone of the repository
git clone https://github.com/LabsCrypt/flowfi.git
cd flowfi
./scripts/verify-clean-clone.sh
```

The script runs, in order, and fails fast on the first error:

1. **Install** — `npm ci` in `backend/` and `frontend/`.
2. **Backend** — type-check and start the backend against a local Postgres, then hit `/health`.
3. **Frontend** — build the Next.js app (`npm run build`).
4. **Contract tests** — `cargo test` in `contracts/`.
5. **Optional testnet smoke** — only runs when testnet credentials are present (see below).

### Local-only values vs. network credentials

The script separates two classes of configuration:

| Class | Examples | Where it lives | Committed? |
|---|---|---|---|
| **Local-only** | `DATABASE_URL=postgres://localhost:5433/flowfi`, `PORT=3001`, `NEXT_PUBLIC_API_URL=http://localhost:3001` | `.env.example` / script defaults | Yes (safe defaults) |
| **Network credentials** | `DEPLOYER_SECRET`, `ADMIN_ADDRESS`, `TREASURY_ADDRESS`, testnet RPC URL | Your shell env / CI secrets | **Never** |

Local-only values have safe defaults baked into the script so a clean clone verifies without any secrets. Network credentials are **never** committed and are only read from the environment.

### Optional testnet smoke checks

The testnet smoke step is **skipped by default**. It runs only when all of the following are set in the environment:

```bash
export FLOWFI_TESTNET_SMOKE=1
export DEPLOYER_SECRET="S..."        # testnet-only key, never commit
export ADMIN_ADDRESS="G..."
export TREASURY_ADDRESS="G..."
```

If `FLOWFI_TESTNET_SMOKE` is unset or any credential is missing, the script prints `SKIP: testnet smoke (credentials not set)` and exits successfully — so local and CI runs never require secrets. When enabled, it deploys to testnet and invokes `initialize` as a smoke check.

> **Secret handling:** never commit `DEPLOYER_SECRET` or any key. Use CI secret stores for periodic runs. The script refuses to run the smoke step if `DEPLOYER_SECRET` looks like a mainnet key or if `FLOWFI_TESTNET_SMOKE` is set without the required addresses.

### CI / periodic run

The same script is invoked by CI on every push and PR (local-only path, no secrets). Maintainers can trigger the testnet smoke path via a scheduled workflow with repository secrets configured.

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

`GET /events/subscribe` streams `text/event-stream` data and keeps the connection open. Postman bu

/* … truncated 8349 chars — edit only what you need near the top … */
