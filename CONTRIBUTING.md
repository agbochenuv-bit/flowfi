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
- [Accessibility: Motion & Contrast](#accessibility-motion--contrast)
- [Mobile Wallet Deep-Link Signer Adapter](#mobile-wallet-deep-link-signer-adapter)
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

## Accessibility: Motion & Contrast

Financial views (live balance updates, charts, and transaction status indicators) must
remain usable for people who disable motion or require stronger visual contrast.

### Motion expectations

- Respect the OS-level `prefers-reduced-motion` setting. When it is enabled, live
  balance changes, chart transitions, and transaction status changes must not animate;
  the updated value/state is applied immediately.
- Motion must never be the *only* carrier of information. Every animated change must
  also be conveyed by text, an icon, or an `aria-live` announcement so the same
  information is available with motion disabled.
- When reduced motion is off, animations are allowed but must stay short and must not
  block interaction.

### Contrast expectations

- Text, status indicators, and chart elements must meet **WCAG 2.1 AA** contrast:
  at least **4.5:1** for normal text and **3:1** for large text, icons, and graphical
  chart elements, in both the default and high-contrast presentations.
- High-contrast mode must not rely on color alone to distinguish statuses; pair color
  with a label or icon.
- Verify contrast with a contrast checker (e.g. browser devtools or the WebAIM
  contrast checker) whenever financial colors or status styles change.

### Automated checks

- Add focused tests for the changed behavior, covering both reduced-motion enabled and
  disabled, high-contrast toggling, and status boundary states (e.g. pending → success
  → failure).
- Run the frontend checks before pushing:

```bash
cd frontend
npm run lint
npm run build
```

### Manual verification notes (critical flows)

Before opening a PR that touches financial views, verify the following manually and
note the results in the PR description:

1. **Keyboard only** — Tab through the balance, chart, and transaction status areas;
   every interactive element is reachable and has a visible focus indicator.
2. **Reduced motion** — Enable "reduce motion" in the OS/browser, then trigger a live
   balance update and a transaction status change; confirm no animation plays and the
   new value/state is still announced.
3. **High contrast** — Toggle high-contrast mode and confirm text, status indicators,
   and chart elements remain distinguishable and meet the contrast ratios above.

---

## Mobile Wallet Deep-Link Signer Adapter

FlowFi supports handing a prepared transaction off to a mobile wallet app via a
deep link. The adapter is a **signer handoff only**: the application and backend
never receive, store, or transmit secret keys or signed secret material. The wallet
holds the keys and returns only the signed transaction envelope (or an error).

### Adapter contract

Any mobile wallet integration must implement the deep-link signer adapter interface
(`MobileWalletSignerAdapter`). The adapter is responsible for:

- Building the outbound deep link from a prepared, unsigned transaction XDR plus the
  expected network passphrase.
- Opening the wallet (or returning the deep link for the caller to open).
- Validating the return link before the signed envelope is accepted.
- Reporting cancellation distinctly from failure.

### Supported wallet capabilities

Document the capabilities of each supported wallet when adding it. At minimum record:

| Capability | Requirement |
| --- | --- |
| Sign transaction | Required — returns signed envelope XDR |
| Network passphrase echo | Required — response must include the network it signed for |
| Cancellation signal | Required — user rejection must be distinguishable from error |
| Return-link scheme | Required — must match the registered callback scheme |
| Multi-op / fee-bump | Optional — note explicitly if unsupported |

### Cancellation

- A user rejecting the request in the wallet must surface as a **cancellation**, not
  a generic error, so the UI can return to an idle state without alarming the user.
- Cancellation must never be treated as a successful signature.

### Return-link validation

- Only accept callbacks whose scheme, host, and path match the registered return link.
- Reject malformed callbacks (missing/extra fields, unparsable payloads, unexpected
  query parameters) and untrusted origins. A rejected callback must not be forwarded
  to the backend or used to build a transaction.
- Validate the returned envelope is well-formed before submission.

### Network matching

- The network passphrase echoed by the wallet must match the expected network for the
  prepared transaction. A mismatch must be rejected; never submit a transaction signed
  for a different network.
- Chain/network validation must not be weakened to make an integration pass.

### Testing expectations

Add focused automated coverage for the adapter, including at least:

- Successful handoff and return-link validation.
- Malformed callbacks (bad scheme/host/path, missing fields, unparsable payload).
- Network mismatch rejection.
- Cancellation path distinct from failure.

---

## Branching Strategy

- `main` — production-ready code
- `develop` — integration branch
- `feature/*` — new features
- `fix/*` — bug fixes
- `docs/*` — documentation updates

Create branches from `develop` and open PRs against `develop` unless instructed otherwise.

---

## Commit Guidelines & Hooks

We use **Conventional Commits**:

```
<type>(<scope>): <short description>
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`.

Examples:

```
feat(sdk): add secure mobile wallet deep-link signer adapter
fix(frontend): handle cancelled wallet handoff
```

Pre-commit hooks run linting and formatting. Do not bypass hooks with `--no-verify`
unless you have a documented reason.

---

## Pull Request Process

1. Fork the repo and create a branch from `develop`.
2. Make focused changes — keep the scope limited to the linked issue.
3. Add or update tests for the changed behavior, including failure and boundary cases.
4. Update the relevant documentation (API, contract, operational, or contributor docs).
5. Ensure `npm run lint` and `npm run build` pass for the affected package.
6. Open a PR with a clear description, the linked issue, and manual verification notes
   for any critical flow you touched.

Keep existing interfaces compatible unless the change explicitly versions them.

---

## Security

- Never commit secrets, private keys, or credentials.
- Never expose secret material to the application or backend. Mobile wallet signing
  happens in the wallet; FlowFi only handles unsigned transactions and signed envelopes.
- Do not weaken wallet authorization, chain/network validation, financial accounting
  invariants, or secret-handling requirements to make an implementation pass.
- Report security issues privately as described in [`SECURITY.md`](../SECURITY.md).

---

## Code of Conduct

Be respectful and constructive. Harassment or abusive behavior is not tolerated.
See [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) for details.
