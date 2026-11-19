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
- [Operator CLI](#operator-cli)
- [SDK Typed Bindings](#sdk-typed-bindings)
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

## Operator CLI

The FlowFi operator CLI lets contributors and operators validate deployment
configuration and inspect public contract and indexer metadata. It is designed to
be safe by default: read-only commands never touch the network unless asked, and
any write command requires explicit confirmation.

### Running the CLI

```bash
# From the repository root
npm run cli -- <command> [options]
```

### Read-only inspection commands

These commands never mutate state and are safe to run against any environment:

```bash
# Validate deployment configuration (offline by default)
npm run cli -- config:validate

# Inspect public contract metadata (network call)
npm run cli -- contract:inspect --network testnet

# Inspect indexer metadata (network call)
npm run cli -- indexer:inspect --network testnet
```

### Write commands

Write commands (for example `deploy`) require an explicit confirmation flag and
will refuse to run without it:

```bash
npm run cli -- deploy --network testnet --confirm
```

### Safety guarantees

- **Explicit confirmation for writes.** Any command that mutates state must be
  invoked with `--confirm`; otherwise the CLI exits non-zero without acting.
- **Secret redaction.** Secret-bearing values (private keys, tokens, connection
  strings) are redacted in all CLI output. Never pass secrets as command-line
  arguments; use environment variables instead.
- **Network validation.** Commands that talk to a network validate the requested
  network against the configured allow-list and fail fast on a wrong-network
  mismatch.
- **Offline mode.** `config:validate` runs fully offline and does not require
  network access, so it can be used in CI and air-gapped environments.

### Testing the CLI

CLI tests run offline and cover the read-only, wrong-network, and
missing-confirmation failure paths:

```bash
cd backend
npm run test -- cli
```

---

## SDK Typed Bindings

The SDK's typed client bindings (contract methods, events, and error types) are
generated from a **pinned** contract interface artifact rather than hand-written,
so the TypeScript surface stays aligned with the deployed contract.

### Pinned inputs

Both the source artifact and the generator toolchain are pinned and committed:

- **Contract interface artifact** — the versioned ABI/interface file under
  `sdk/contract-interface/` (e.g. `stream_contract.interface.json`). Its version
  and content hash are recorded in `sdk/contract-interface/PINNED.json`.
- **Generator toolchain** — the binding generator version is pinned in
  `sdk/package.json` (and the lockfile). Do not bump it without regenerating and
  committing the output in the same change.

### Regenerating bindings

After changing the contract interface (or intentionally bumping the generator),
regenerate the committed bindings from the repository root:

```bash
# 1. Update the pinned artifact + hash (only when the interface changed)
npm run sdk:pin-interface

# 2. Regenerate typed bindings from the pinned artifact
npm run sdk:generate-bindings

# 3. Commit the pinned artifact, PINNED.json, and generated bindings together
git add sdk/contract-interface sdk/src/generated
```

Generated files live under `sdk/src/generated/` and must never be edited by
hand — changes are overwritten on the next regeneration.

### Drift check in CI

CI runs a drift check that regenerates bindings from the pinned artifact and
fails if the committed output differs. Run it locally before pushing:

```bash
npm run sdk:check-bindings
```

If this fails, run the regeneration steps above and commit the result. A drift
failure means the committed bindings no longer match the pinned interface or the
pinned generator version.

---

## CI/CD Workflows

This repository uses GitHub Actions for continuous integration. Workflows are located in `.github/workflows/`.

### Available Workflows

- **Security Checks** (`.github/workflows/security.yml`)
  - Runs on: push to `main`/`develop`, pull requests, and weekly schedule
  - Performs:
    - Dependency vulnerability scanning (`npm audit`)
    - CodeQL analysis for JavaScript/TypeScript
    - Secret scanning
    - License compliance checks

- **CI** (`.github/workflows/ci.yml`)
  - Runs on: pull requests and pushes to `main`/`develop`
  - Performs:
    - Backend build and tests
    - Frontend lint and build
    - Contract build and tests
    - SDK binding drift check (`npm run sdk:check-bindings`)

### Running Checks Locally

Before opening a PR, run the relevant checks locally:

```bash
# Backend
cd backend && npm run build && npm run test

# Frontend
cd frontend && npm run lint && npm run build

# Contracts
cd contracts && cargo test

# SDK bindings drift
npm run sdk:check-bindings
```

---

## Branching Strategy

- `main` — production-ready code
- `develop` — integration branch
- `feature/*` — new features
- `fix/*` — bug fixes
- `docs/*` — documentation updates

Create branches from `develop` and open PRs against `develop`.

---

## Commit Guidelines & Hooks

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.

### Pre-commit Hooks

This repository uses Husky and lint-staged. On commit, staged files are
formatted and linted automatically. Do not bypass hooks with `--no-verify`
unless you have a documented reason.

---

## Pull Request Process

1. Fork the repository and create a branch from `develop`.
2. Make your changes and add tests where relevant.
3. Ensure all local checks pass (see [Running Checks Locally](#running-checks-locally)).
4. Open a PR against `develop` with a clear description and linked issue.
5. Address review feedback and keep the branch up to date.

PRs that change the contract interface must include the regenerated SDK
bindings and the updated pinned artifact in the same PR.

---

## Security

- Never commit secrets, private keys, or credentials.
- Report vulnerabilities privately per [`SECURITY.md`](SECURITY.md).
- Do not weaken wallet authorization, chain/network validation, financial
  accounting invariants, or secret-handling requirements to make a change pass.

---

## Code of Conduct

By participating, you agree to abide by our [Code of Conduct](CODE_OF_CONDUCT.md).
