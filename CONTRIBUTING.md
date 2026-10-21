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

## Database Migrations & Rollout

Production PostgreSQL schema changes must be **deployment-safe**: the API and worker
processes are rolled out independently, so for a window of time the *previous* and
*new* application versions run against the *same* database. Every migration must
therefore be backward-compatible with the previously deployed application version.

### Ground Rules

1. **Never edit an existing migration file.** Migration files are immutable once
   merged. Any schema change — including a fix to a previous migration — must be
   expressed in a **new** migration file. Editing history breaks `prisma migrate`
   checksums and can silently skip changes on environments that already applied them.
2. **No destructive changes in a single step.** Dropping a column/table, renaming,
   adding a `NOT NULL` constraint without a default, or narrowing a type must be
   split across releases (see expand/backfill/contract below).
3. **Pin the previous supported schema.** The migration replay test
   (`backend/tests/migrations/`) snapshots the schema of the previous supported
   release and replays all migrations on top of it, asserting no data loss and no
   errors. Update the pinned snapshot only when a release is promoted to
   "previous supported".
4. **Document externally observable behavior.** Each migration PR must state what
   changes for API consumers, workers, and operators (new/removed fields, changed
   nullability, index/lock impact, expected downtime, backfill duration).

### Expand / Backfill / Contract Pattern

Changes that overlap active API and worker versions are shipped in three phases,
each in its own release:

| Phase | What you do | Compatibility |
| --- | --- | --- |
| **Expand** | Add new nullable columns, new tables, new indexes (`CREATE INDEX CONCURRENTLY` where supported). Keep old columns intact. | Old and new app versions both work. |
| **Backfill** | Populate new columns/tables from existing data (batched, idempotent job). Dual-write from the application if reads must stay consistent. | Old version ignores new data; new version tolerates missing data. |
| **Contract** | Once all running versions use the new shape, drop old columns/tables, add `NOT NULL`/`UNIQUE` constraints, and remove dual-writes. | Only the new version is deployed. |

### Rollout Checklist

Copy this into the migration PR description and tick each item:

- [ ] Change is in a **new** migration file; no existing migration was modified.
- [ ] Change is classified as **expand**, **backfill**, or **contract** (or is a
      non-breaking additive change that needs no phasing).
- [ ] Previous application version still works against the migrated schema
      (expand/backfill phases only).
- [ ] Previous supported schema snapshot is pinned/updated in the migration replay
      test and `npm run test:migrations` passes locally.
- [ ] CI `migration-replay` job is green.
- [ ] Backfill (if any) is batched, idempotent, resumable, and safe to re-run.
- [ ] Locking/index impact assessed; long-running DDL uses concurrent variants or a
      maintenance window.
- [ ] Rollback plan documented (forward-fix migration preferred; no data loss).
- [ ] Externally observable behavior documented: API/worker contract changes,
      operational impact (downtime, backfill duration, index build time).
- [ ] Regression and boundary tests added at the owning component's test layer
      (e.g. `backend/tests/` for API/DB behavior).

### Operational Impact Notes

- **Expand** migrations are additive and should be deployable with zero downtime;
  note any index build time on large tables.
- **Backfill** jobs run alongside live traffic; document expected duration, batch
  size, and how to pause/resume.
- **Contract** migrations are the only ones allowed to remove or tighten schema;
  they must ship only after the expand+backfill release is fully rolled out to all
  API and worker instances.

---

# Branching Strategy

❌ Do NOT commit directly to `main`
✅ Always create a feature branch

## Branch Naming Convention

| Type     | Format                       | Example                       |
| -------- | ---------------------------- | ----------------------------- |
| Feature  | `feature/short-description`  | `feature/add-stream-cancel`   |
| Bug Fix  | `fix/short-description`      | `fix/dashboard-loading-error` |
| Refactor | `refactor/short-description` | `refactor/api-service-layer`  |
| Docs     | `docs/short-description`     | `docs/update-contributing`    |
| Infra    | `infra/short-description`    | `infra/docker-improvement`    |

## Create a Branch

```bash
git checkout -b feature/your-feature-name
```

Keep branch names short and descriptive.

---

# Commit Guidelines & Hooks

This repository uses **Husky** for commit hooks, with **lint-staged** running checks
only against the files you staged:

| Staged files | Check |
| --- | --- |
| `frontend/**/*.{ts,tsx,js,jsx}` | ESLint |
| `contracts/**/*.rs` | `cargo fmt --check` + `cargo clippy -D warnings` |

Rust checks are skipped automatically when Cargo is not installed, so a
JavaScript-only contributor is never blocked. Install a Rust toolchain
(`rustup`) to have them enforced locally before CI does.

Before committing, ensure:

- Code compiles
- Lint passes
- No broken builds

## Commit Message Format

We follow a conventional style:

```
type(scope): short description
```

### Examples

```
feat(frontend): add wallet balance card
fix(backed): resolve stream validation bug
refactor(contracts): simplify transfer logic
docs: update setup instructions
```

## Commit Rules

- Use present tense ("add", not "added")
- Keep subject under ~72 characters
- Make atomic commits (one logical change per commit)
- Avoid vague messages like "update stuff"

---

# Pull Request Process

## Sync with Main

Before opening a PR:

```bash
git checkout main
git pull origin main
git checkout your-branch
git rebase main
```

Resolve conflicts locally if any.

---

## Push Your Branch

```bash
git push origin your-branch-name
```

---

## 3 Open a Pull Request

When opening your PR:

- Provide a clear title
- Add a detailed description
- Link related issues (e.g., `Closes #45`)
- Add screenshots for UI changes
- Explain why the change is needed

---

## PR Requirements

Your PR must:

- Build successfully
- Pass lint checks
- Follow commit conventions
- Be properly described
- Stay focused (avoid large unrelated changes)
- For database changes: follow the [Database Migrations & Rollout](#database-migrations--rollout)
  checklist and include the completed checklist in the PR description

---

## Code Review

Maintainers may:

- Request changes
- Ask clarifying questions
- Suggest improvements

Please respond respectfully and update your branch as requested.

---

# 🔒 Security

If you discover a security vulnerability, please do **NOT** open a public issue. Instead, follow our responsible disclosure process outlined in our [Security Policy](SECURITY.md).

Security vulnerabilities should be reported privately to allow us to address them before public disclosure.

---

# 📜 Code of Conduct

This project follows a Code of Conduct to ensure a welcoming and inclusive community.

Please read and follow our Code of Conduct before contributing:

**[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)**

Be respectful.
Be collaborative.
Be constructive.

---



---

# 🤝 Contributor Badges

This project uses the [all-contributors](https://github.com/all-contributors/all-contributors) specification to recognize contributors.

## Triggering the Bot

After your pull request is merged or closed, comment on the merged PR or issue:

```
@all-contributors please add @<your-username> for code
```

The bot will add your profile to the Contributors table in the root `README.md`.

## Adding Sub-Package READMEs

Currently, only the root `README.md` has a Contributors section. If you add a Contributors section to a sub-package README (e.g., `backend/README.md`, `frontend/README.md`, `contracts/README.md`), update `.all-contributorsrc` in the repo root to include the additional path:

```json
"files": [
  "README.md",
  "backend/README.md"
]
```

## Available Contribution Types

- `code` — Code contributions
- `doc` — Documentation
- `design` — Design
- `bug` — Bug reports
- `review` — Pull Request reviews
- `test` — Testing
- `infra` — Infrastructure / DevOps
- `ideas` — Ideas & planning


# Final Notes

- Contributions of all sizes are welcome
- Documentation improvements are valuable
- Ask questions in Issues if unsure
- Keep PRs small and manageable

Thank you for helping improve FlowFi 💙
