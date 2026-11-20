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

## Partner onboarding & go-live checklist

This suite is the reference harness external partners use to prove their
integration before going live. Work through the checklist **in order** on a
clean environment; do not publish or enable production traffic until every box
is checked.

### 0. Testnet vs production separation (do this first)

Testnet and production must never share credentials, endpoints, or databases.
Use a dedicated `.env` per environment and keep production secrets out of the
repo and out of any testnet shell.

| Concern | Testnet | Production |
| --- | --- | --- |
| RPC | `https://soroban-testnet.stellar.org` | your production Soroban RPC |
| Horizon | `https://horizon-testnet.stellar.org` | your production Horizon |
| Network passphrase | Testnet passphrase | Public passphrase |
| Friendbot | `https://friendbot.stellar.org` | **never** — fund via treasury |
| Contract ID | testnet deployment | production deployment |
| Database | disposable local DB | managed production DB |
| API keys / signing keys | testnet-only keys | production keys from a secret manager |

A mismatch here is the most common go-live failure. The suite refuses to run
against a passphrase that does not match the configured RPC/Horizon pair, so a
mixed `.env` fails fast instead of silently passing.

### 1. Configure credentials

```bash
cd backend
cp .env.example .env.testnet   # never commit this file
# Fill in testnet-only values, then load them for the session:
set -a && . ./.env.testnet && set +a
```

Verify the credentials resolve before running anything:

```bash
# Fails loudly if a required var is missing or still points at production.
npm run test:e2e:testnet -- network-health
```

Boundary cases to confirm by hand:

- **Missing credential** — unset `E2E_SOROBAN_RPC_URL`; the run must fail with a
  clear "missing configuration" error, not a network timeout.
- **Invalid credential** — set `E2E_SOROBAN_RPC_URL` to a bogus host; the run
  must fail fast with a connection error.
- **Testnet/production mismatch** — set `E2E_NETWORK_PASSPHRASE` to the public
  passphrase while keeping testnet endpoints; the run must abort with a
  mismatch error.

### 2. Validate webhook handling

Point your webhook receiver at the testnet indexer and confirm:

- A validly signed delivery is accepted and processed.
- A delivery with a **tampered signature** is rejected (non-2xx) and logged.
- A delivery with a **missing signature header** is rejected.
- Replayed deliveries are idempotent (no double accounting).

```bash
# Drive a real event through the indexer, then assert your receiver saw it:
npm run test:e2e:testnet -- stream-lifecycle
```

### 3. Test reconciliation

Reconciliation must match on-chain state to your ledger exactly:

- Run the indexer suite against a disposable DB (it resets the cursor).
- Confirm hashes, ledgers, and amounts match between chain and DB.
- Confirm a **boundary** case: a stream that is created and cancelled in the
  same ledger reconciles to zero net balance, not a partial amount.

```bash
export DATABASE_URL=postgresql://flowfi:flowfi_dev_password@127.0.0.1:5433/flowfi
npx prisma db push --schema=prisma/schema.prisma
npm run test:e2e:testnet
```

### 4. Clean-environment validation (required before publication)

Before publishing or enabling production traffic, reproduce the full run from a
**fresh checkout with no cached state**:

```bash
git clean -xdf && git checkout .
cd backend && npm ci
set -a && . ./.env.testnet && set +a
npm run test:e2e:testnet
```

All suites must pass with zero skips that hide a required check. Record the run
(commit SHA, date, pass/fail) in your go-live ticket.

### 5. Go-live sign-off

- [ ] Testnet and production configs are fully separated (no shared secrets).
- [ ] Missing/invalid credential and passphrase-mismatch cases fail fast.
- [ ] Webhook signature failure and missing-signature cases are rejected.
- [ ] Reconciliation matches chain↔DB, including the same-ledger boundary case.
- [ ] Clean-environment run passes and is recorded.
- [ ] Production secrets live in a secret manager, not in the repo or shell history.
