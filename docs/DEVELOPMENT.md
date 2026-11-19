# Development Guide

## Verify a clean checkout

Install Git, Bash, curl, Node.js 22.12+ with npm, Docker with a running daemon,
and stable Rust with Cargo. Use a fresh checkout with ports 3000 and 3001 free.

```bash
git clone https://github.com/agbochenuv-bit/flowfi.git
cd flowfi
bash scripts/verify-clean-clone.sh
```

The script installs the locked workspace dependencies, creates a disposable
Postgres database on a loopback port, generates Prisma and applies the schema,
builds and tests the backend and frontend, and runs the contract tests. It then
starts both builds and checks their HTTP responses before cleaning up the
processes and database. The CI **Clean clone verification** job runs this path.

The database password is a local fixture. The script generates a fresh local
JWT signing key on every run. The script rejects environment files and starts application commands
with an isolated environment. Use a separate checkout for long-running
development with the [backend](../backend/README.md) and
[frontend](../frontend/README.md) setup instructions.

## Optional Stellar Testnet smoke

```bash
bash scripts/verify-clean-clone.sh --testnet-smoke
```

This adds the existing network-health suite against public Testnet and Friendbot.
It uses disposable test accounts and the suite's default endpoints, with no
operator credentials. The scheduled [Testnet E2E workflow](../.github/workflows/testnet-e2e.yml)
runs the same network-health suite with the full contract lifecycle.
For contract deployment and indexed lifecycle verification, follow the
[Testnet E2E runbook](../backend/e2e/testnet/README.md) using a separate scratch
database and Testnet-only identities. Keep Mainnet keys and deployment secrets
in the deployment secret store.

## Common Issues

### Indexer not syncing

* Ensure worker/indexer is running
* Confirm correct Stellar network (testnet/mainnet)
* Check DB cursor/state
* Review logs for RPC/Horizon errors

---

### SSE issues

* Verify JWT token validity
* Check `/v1/events/stats`
* Ensure Redis is running (multi-instance mode)
* Confirm connection limits are not exceeded

---

### Auth failures (401/403)

* Ensure wallet signature matches public key
* Verify `JWT_SECRET`
* Confirm Bearer token is included

---

### Database migration issues

* Check `DATABASE_URL`
* Run `prisma generate`
* Reset DB if schema drift occurs
* Check `backend/prisma.config.ts` — it sets the schema path, migrations path, and the `DATABASE_URL` the CLI uses ([details](../backend/README.md#troubleshooting))

---
