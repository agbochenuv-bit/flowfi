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

## Contract Artifact & Interface Snapshots

Contract builds are pinned so that interface changes are detected deterministically.

### Pinned build inputs

- **Toolchain**: the Rust toolchain is pinned via `contracts/rust-toolchain.toml`
  (channel + `wasm32-unknown-unknown` target). Do not bump it in an unrelated PR.
- **Environment**: builds run with `SOURCE_DATE_EPOCH` fixed and `CARGO_INCREMENTAL=0`
  so metadata does not vary between machines.
- **Target**: `wasm32-unknown-unknown` in `--release` mode.

### What is compared

We do **not** require byte-identical WASM artifacts across machines — the compiler
may emit non-deterministic bytes even with pinned inputs. Instead, the snapshot
tests compare **stable metadata**:

- the exported contract interface (function names, argument types, return types)
- the contract spec / ABI entries

These snapshots live alongside the contract tests and are checked in CI.

### Updating snapshots intentionally

When you intentionally change a contract interface:

1. Run the contract snapshot tests locally and confirm the diff is exactly the
   interface change you intended.
2. Regenerate the snapshot with the documented update command (see the snapshot
   test module header) and commit the updated snapshot **in the same PR** as the
   interface change.
3. Call out the interface change in the PR description. If the change is
   breaking, version the interface explicitly rather than silently altering it.

Snapshot drift that you did not intend is a failure — investigate before
regenerating. Never regenerate a snapshot just to make CI green.

---

## Secret-Leak Regression Checks

CI includes regression tests that fail if credentials, signed payloads, or
wallet-linked secrets leak into test logs, build artifacts, or failure
diagnostics. These checks run as part of the normal test suites and require no
special setup.

### How the checks work

- Tests inject **synthetic canary values** (fake tokens, fake signed payloads,
  fake wallet addresses/keys) into the code paths that log or serialize data.
- They then assert the canary never appears in captured logs, generated
  artifacts, or thrown error diagnostics.
- Coverage includes failure and boundary cases: nested error objects, partial
  matches, and empty/undefined values.

### Rules for contributors

- **Never** add real secrets, tokens, or wallet keys to test fixtures. Use
  synthetic canaries only.
- Do not weaken or skip these checks to make a PR pass. If a check fails, the
  fix is to redact the leaking path — not to relax the assertion.
- Do not change runtime secret-handling behavior as part of an unrelated PR.

### Extending the checks

When you add a new log line, artifact, or error path that may carry sensitive
data:

1. Add a synthetic canary for the new field (e.g. `canary-token-<name>`).
2. Feed it through the new path in the relevant test suite.
3. Assert the canary is absent from logs, artifacts, and diagnostics, and that
   the redacted placeholder is present where expected.
4. Include a failure/boundary case (nested object, partial match, or empty
   value) alongside the happy path.

---

## Development Scripts & Tools

### Root-Level Scripts

From the repository root:

```bash
# Verify security setup
npm run verify-security
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
    - Backend: migration replay va

/* … truncated 1706 chars — edit only what you need near the top … */
