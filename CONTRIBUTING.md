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
- [Issue-Linked Change Acceptance Policy](#issue-linked-change-acceptance-policy)
- [Accessibility Audit](#accessibility-audit)
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

---

## Issue-Linked Change Acceptance Policy

Every pull request must be **linked to a GitHub issue** and must carry the evidence
required by the kind of change it makes. The policy is enforced by the
`pr-test-gate` workflow and the pull request template.

---

## Accessibility Audit

Accessibility is a release gate for the critical user flows: **wallet setup**,
**stream creation**, **transaction confirmation**, and **error recovery**. Every
change that touches these flows must keep them usable with a keyboard alone and
with a screen reader.

### Automated checks (CI)

Automated accessibility checks run in CI on every pull request via the
`accessibility` job in `.github/workflows/ci.yml`. The job runs the frontend
`axe`-based test suite (`npm run test:a11y`), which asserts:

- every interactive control in the critical flows has an accessible name
  (missing labels fail the build);
- focus is not trapped and moves in a logical order through each flow;
- error states are announced via an ARIA live region (`role="alert"` or
  `aria-live`), including validation failures and transaction errors;
- boundary cases: empty/whitespace input, disabled submit while pending, and
  recovery after a failed transaction.

Run the same suite locally before pushing:

```bash
cd frontend
npm run test:a11y
```

### Manual scenarios

Automated checks cannot cover real assistive-technology behavior. Before merging
changes to a critical flow, run the following manual scenarios and record the
result in the pull request description.

| Flow | Keyboard scenario | Screen-reader scenario | Remediation owner |
| --- | --- | --- | --- |
| Wallet setup | Tab to the connect button, activate with Enter/Space, complete the wallet prompt, and confirm focus lands on the next actionable control. | With VoiceOver/NVDA, confirm the connect button, wallet status, and any connection error are announced. | Frontend maintainer on-call |
| Stream creation | Tab through recipient, amount, and duration fields; confirm labels are announced and the submit button is reachable and disabled until valid. | Confirm each field label, validation message, and the submit state are announced. | Frontend maintainer on-call |
| Transaction confirmation | Tab to confirm/cancel; confirm focus is trapped within the dialog and returns to the trigger on close. | Confirm the dialog title, summary, and confirm/cancel actions are announced. | Frontend maintainer on-call |
| Error recovery | Trigger a failed transaction; confirm the error is announced and focus moves to the retry action. | Confirm the error message and retry path are announced without losing context. | Frontend maintainer on-call |

If a manual scenario fails, open an issue labeled `accessibility` and assign it
to the remediation owner listed above. Do not merge the change until the
failure is fixed or an explicit, time-boxed exception is approved by a
maintainer.

---

## Security

If you discover a security vulnerability, please follow the process described in
[SECURITY.md](SECURITY.md). Do not open a public issue for security problems.

---

## Code of Conduct

By participating in this project, you agree to abide by our
[Code of Conduct](CODE_OF_CONDUCT.md).
