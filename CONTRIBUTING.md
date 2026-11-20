# Contributing to FlowFi

Thank you for your interest in contributing to **FlowFi**

FlowFi is a DeFi payment streaming protocol built on Stellar using Soroban smart contracts. This guide explains how to set up your local development environment and contribute effectively.

Please read this document carefully before opening a Pull Request.

## Getting Help & Asking Questions

Have questions before contributing? We've got you covered!

- **Questions about using FlowFi?** → Start a discussion in [GitHub Discussions - Q&A](https://github.com/LabsCrypt/flowfi/discussions/categories/q-a)
- **Found a bug?** → [Open an Issue](https://github.com/LabsCrypt/flowfi/issues)
- **Want to suggest a feature?** → [Start a Discussion - Ideas](https://github.com/LabsCrypt/flowfi/discussions/categories/ideas)
- **Need help setting up?** → Check [Local Development Setup](#local-development-setup) or ask in Discussions

### Issues vs Discussions

**Open an Issue if:**

- You found a bug 🐛
- You want to work on a concrete feature or task ✨
- There's a documentation problem 📝

**Start a Discussion if:**

- You have a question ❓
- You want to propose and discuss a feature 💡
- You're sharing a project or use case 🎪

See our [Discussions Guide](DISCUSSIONS.md) for more details.

---

## Table of Contents

- [Getting Help & Asking Questions](#getting-help--asking-questions)
- [Project Overview](#project-overview)
- [Local Development Setup](#local-development-setup)
- [Clean-Clone Verification](#clean-clone-verification)
- [Branching Strategy](#branching-strategy)
- [Commit Guidelines & Hooks](#commit-guidelines--hooks)
- [Pull Request Process](#pull-request-process)
- [Security](#security)
- [Code of Conduct](#code-of-conduct)

---

## Project Overview

FlowFi is structured as a monorepo:

```
flowfi/
├── backend/      # Express.js + TypeScript backend
├── contracts/    # Soroban smart contracts (Rust)
├── frontend/     # Next.js + Tailwind CSS frontend
```

Technologies used:

- **Frontend**: Next.js + TypeScript + Tailwind CSS
- **Backend**: Express.js + TypeScript
- **Smart Contracts**: Rust + Soroban
- **Database**: PostgreSQL
- **Containerization**: Docker & Docker Compose

---

# Local Development Setup

## Fork & Clone the Repository

Fork & Clone the Repository

First, fork the repository on GitHub.

Then clone your fork locally:

```bash
git clone https://github.com/YOUR-USERNAME/flowfi.git
cd flowfi
```

## Prerequisites

Make sure you have the following installed:

- Node.js (LTS recommended)
- npm
- Rust & Cargo
- Docker & Docker Compose
- (Optional) Stellar CLI

---

## Option 1: Docker (Recommended)

The fastest way to run the full stack locally:

```bash
docker compose up --build
```

This starts:

- PostgreSQL (port 5433)
- Backend API (port 3001)

To run in detached mode:

```bash
docker compose up -d --build
```

To stop services:

```bash
docker compose down
```

To reset the database:

```bash
docker compose down -v
```

---

## Option 2: Manual Setup

### Backend Setup

1. **Install Dependencies**

```bash
cd backend
npm install
```

2. **Set Up Database**

The backend uses PostgreSQL. You can either:

- Use Docker Compose (recommended): `docker compose up postgres -d`
- Or set up PostgreSQL locally and configure `DATABASE_URL` in your `.env` file

3. **Run Database Migrations**

```bash
npm run prisma:generate
npm run prisma:migrate
```

4. **Start Development Server**

```bash
npm run dev
```

Backend runs on: `http://localhost:3001`

**Available Backend Scripts:**

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm run start` - Start production server
- `npm run test` - Run test suite
- `npm run prisma:generate` - Generate Prisma client
- `npm run prisma:migrate` - Run database migrations
- `npm run prisma:studio` - Open Prisma Studio (database GUI)

**Backend API Documentation:**

- Swagger UI: `http://localhost:3001/api-docs`
- OpenAPI Spec: `http://localhost:3001/api-docs.json`

---

### Frontend Setup

1. **Install Dependencies**

```bash
cd frontend
npm install
```

2. **Start Development Server**

```bash
npm run dev
```

Frontend runs on: `http://localhost:3000`

**Available Frontend Scripts:**

- `npm run dev` - Start Next.js development server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Run ESLint

**Environment Variables:**
Copy [`frontend/.env.example`](../frontend/.env.example) to `frontend/.env.local` and adjust as needed. The `.env.example` file documents every `NEXT_PUBLIC_*` variable the application reads, with sensible testnet defaults.

---

### Smart Contracts Setup

1. **Install Rust Toolchain**

Make sure you have Rust and Cargo installed. If not:

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

2. **Install Soroban CLI** (if not already installed)

```bash
cargo install --locked soroban-cli
```

3. **Build Contracts**

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

The compiled WASM files will be in `target/wasm32-unknown-unknown/release/`.

**Contract Development:**

- Contract source: `contracts/stream_contract/src/lib.rs`
- Tests: `contracts/stream_contract/src/test.rs`
- Build target: `wasm32-unknown-unknown`

---

## Clean-Clone Verification

This section provides a fully scripted, reproducible path from a **clean clone** to a
verified local stack: backend, frontend, contract tests, and an optional testnet smoke
check. Every command below is validated by CI (see [CI/CD Workflows](#cicd-workflows));
the testnet smoke step is validated by a documented periodic run.

### Scripted entry point

Run the verification script from the repository root:

```bash
./scripts/verify-clean-clone.sh
```

The script performs, in order:

1. **Clone** — clones the repository into a fresh temporary directory (or uses the
   current checkout when `--in-place` is passed).
2. **Install** — installs backend and frontend dependencies (`npm ci`).
3. **Backend** — generates the Prisma client, builds, and runs the backend test suite
   against a throwaway PostgreSQL instance.
4. **Frontend** — runs lint and build.
5. **Contract tests** — builds the Soroban contract for `wasm32-unknown-unknown` and
   runs `cargo test`.
6. **Testnet smoke (optional)** — only runs when the required network credentials are
   present; otherwise it is skipped with a clear message.

### Local-only values vs. network credentials

Keep these two categories strictly separate. **Never commit secrets.**

**Local-only values** (safe defaults, no real funds, no secrets):

| Variable | Purpose | Example |
| --- | --- | --- |
| `DATABASE_URL` | Local PostgreSQL connection | `postgresql://postgres:postgres@localhost:5433/flowfi` |
| `PORT` | Backend listen port | `3001` |
| `NEXT_PUBLIC_API_URL` | Frontend → local backend | `http://localhost:3001` |
| `NEXT_PUBLIC_STELLAR_NETWORK` | Target network for the UI | `testnet` |

These may live in a local `.env` / `.env.local` (git-ignored) and are documented in the
respective `.env.example` files.

**Network credentials** (testnet smoke only — never committed, never logged):

| Variable | Purpose |
| --- | --- |
| `STELLAR_TESTNET_SECRET_KEY` | Funded testnet account secret used for the smoke check |
| `STELLAR_TESTNET_RPC_URL` | Testnet Soroban RPC endpoint |
| `STELLAR_TESTNET_CONTRACT_ID` | Deployed testnet contract to smoke-test |

Provide these only via your shell environment or CI secrets. The script treats them as
optional: if any are missing, the testnet smoke step is **skipped** (not failed), and the
local verification still passes. The script never echoes secret values.

### Running the testnet smoke manually

```bash
export STELLAR_TESTNET_SECRET_KEY=...   # from your secret store, never committed
export STELLAR_TESTNET_RPC_URL=https://soroban-testnet.stellar.org
export STELLAR_TESTNET_CONTRACT_ID=...
./scripts/verify-clean-clone.sh --testnet-smoke
```

### CI validation

The `clean-clone-verification` job in `.github/workflows/ci.yml` runs the script on every
push and pull request, exercising steps 1–5. The optional testnet smoke step runs in a
documented **periodic** workflow (weekly schedule) where the testnet credentials are
provided as repository secrets; when secrets are absent the step is skipped, matching the
local behavior.

---

## Development Scripts & Tools

### Root-Level Scripts

From the repository root:

```bash
# Verify security setup
npm run verify-security

# Fully scripted clean-clone verification
./scripts/verify-clean-clone.sh
```

### Docker Compose Commands

```bash
# Start all services
docker compose up --build

# Start in detached mode
docker compose up -d --build

# View logs
docker compose logs -f

# Stop services

docker compose down

# Reset database (removes volumes)
docker compose down -v
```

---

## CI/CD Workflows

This repository uses GitHub Actions for continuous integration. Workflows are located in `.github/workflows/`.

### Available Workflows

- **Security Checks** (`.github/workflows/security.yml`)
  - Runs on: push to `main`/`develop`, pull requests, and weekly schedule
  - Performs:
    - Dependency vulnerability scanning (`npm audit`)
    - CodeQL analysis for JavaScript/TypeScript
  - View workflow: [Security Checks](.github/workflows/security.yml)

- **CI** (`.github/workflows/ci.yml`)
  - Runs on: push to `main`/`develop` and pull requests
  - Performs:
    - Frontend: lint and build
    - Backend: prisma generation, build, and tests
    - Backend: migration replay validation (see [Database Migrations & Rollout](#database-migrations--rollout))
    - Soroban Contracts: build (wasm) and tests
    - Clean-clone verification: runs `./scripts/verify-clean-clone.sh` (steps 1–5)
  - View workflow: [CI](.github/workflows/ci.yml)

### Running CI Checks Locally

Before pushing, ensure your changes pass all the same checks that run in GitHub Actions.

#### 1. Frontend Checks
```bash
cd frontend
npm run lint    # Runs ESLint
npm run build   # Verifies the build
```

#### 2. Backend Checks
```bash
cd backend
npm run prisma:generate  # Ensure Prisma client is up to date
npm run build           # Verifies TypeScript compilation
npm run test            # Runs backend vitest suite
```
*Note: Backend tests require a running PostgreSQL instance and `DATABASE_URL` environment variable.*

#### 3. Smart Contract Checks
```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release  # Verifies contract build
cargo test                                            # Runs contract tests
```

#### 4. Security Verification
```bash
# From the repository root
npm run verify-security
```

#### 5. Migration Replay Validation
```bash
cd backend
npm run test:migrations   # replays migrations from the previous supported schema
```
*Note: This requires a running PostgreSQL instance and `DATABASE_URL` environment variable.
The same check runs in CI as the `migration-replay` job.*

#### 6. Clean-Clone Verification
```bash
# From the repository root
./scripts/verify-clean-clone.sh
```
*Note: This is the same scripted flow described in [Clean-Clone Verification](#clean-clone-verification).
It runs in CI as the `clean-clone-verification` job.*

---

## Database Migrations & Rollout

Production PostgreSQL schema changes must be **deployment-safe**: the API and worker
processes are rolled out independently, so for a window of time the *previous* and
*new* application versions run against the *same* database. Every migration must
remain backward compatible with the previous application version.
