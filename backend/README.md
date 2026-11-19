# FlowFi Backend

This is the Node.js / Express backend for FlowFi. It provides the REST API for the frontend, indexes on-chain events from the Stellar network, and serves real-time updates via Server-Sent Events (SSE).

## Scripts

- `npm install`: Installs dependencies.
- `npm run dev`: Starts the development server using nodemon.
  
  > **Note:** nodemon watches only the `src/` directory for changes. Tests live in the `tests/` directory (outside the watch scope), so they never trigger server reloads. If tests were ever colocated inside `src/` in the future, add ignore patterns (e.g. `src/**/*.test.ts`) to nodemon.json to prevent unwanted restarts.
- `npm run build`: Compiles TypeScript to JavaScript.
- `npm start`: Runs the compiled server.
- `npm run db:push`: Pushes Prisma schema changes to the database.

## Environment Variables

Create a `.env` file with the following variables:

```env
DATABASE_URL=postgresql://flowfi:flowfi_dev_password@localhost:5433/flowfi?schema=public
PORT=3001
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
API_BASE_URL=https://api.staging.flowfi.io
```

- `API_BASE_URL`: Overrides the Swagger UI server URL for the deployed environment (e.g., staging or production). When set, Swagger UI targets `<API_BASE_URL>/v1` instead of the hardcoded defaults.
- `DATABASE_URL` is required before the backend starts. Production additionally requires `JWT_SECRET`, `KEEPER_SECRET_KEY`, `ADMIN_PUBLIC_KEY`, `SOROBAN_RPC_URL`, `STELLAR_NETWORK`, `STREAM_CONTRACT_ID`, `CORS_ALLOWED_ORIGINS`, and an HTTPS `API_BASE_URL`. Production startup rejects placeholders, weak signing keys, invalid Stellar keys, network mismatches, wildcard/insecure origins, and enabled sandbox mode. `SOROBAN_RPC_URLS` may add pool failover endpoints but does not replace the primary URL.

## Prisma Database

We use Prisma as our ORM to interact with PostgreSQL.

- Schema is located at `prisma/schema.prisma`.
- Configuration (schema path, migrations path, datasource URL) is defined in `prisma.config.ts`.
- Run `npx prisma studio` to view the database through a web UI.

### `prisma.config.ts` vs `prisma/schema.prisma`

There are two Prisma files, and they do different jobs:

| File | Owns |
| ---- | ---- |
| `prisma/schema.prisma` | The **data model** — models, enums, relations, the `datasource` and `generator` blocks. This is what `prisma generate` turns into the client. |
| `prisma.config.ts` | The **Prisma CLI configuration** — where the CLI looks for things and how it connects when you run `prisma generate`, `prisma migrate`, `prisma db push`, or `prisma studio`. |

`prisma.config.ts` exists as a separate file because it is TypeScript that Node evaluates before the CLI runs, so it can do things `schema.prisma` cannot — most importantly read environment variables. Prisma 7 (this project is on `prisma@^7.4.1`) no longer auto-loads `.env` for CLI commands, which is why the file starts with `import "dotenv/config"`.

What it currently sets:

- `schema: "prisma/schema.prisma"` — path to the schema, so CLI commands work from the `backend/` directory without a `--schema` flag.
- `migrations.path: "prisma/migrations"` — where migration folders are read from and written to.
- `datasource.url: process.env["DATABASE_URL"]` — the connection string the CLI uses.

### Seeding the database

`prisma/seed.ts` populates the database with demo fixtures for local development. Run it with:

```bash
npm run prisma:seed
```

(this runs `prisma db seed`, which in turn runs `tsx prisma/seed.ts` as configured under the `prisma.seed` key in `package.json`.)

The script is idempotent (it uses `upsert`/fixed IDs), so it's safe to run multiple times. It creates:

- Two demo users, keyed by fixed Stellar testnet public keys — a sender (`GCM5WPR4DDR24FSAX5LIEM4J7AI3KOWJYANSXEPKYXCSZOTAYXE75AFN`) and a recipient (`GBJCHUKZMTFSLOMNC7P4TS4VJJBTCYL3XKSOLXAUJSD56C4LHND5TWUC`).
- One demo `Stream` (`streamId: 101`) between those two users, using a fixed demo token address, with a sample rate/deposit amount and `isActive: true`.
- One demo `StreamEvent` (`eventType: 'CREATED'`) attached to that stream, with sample transaction hash, ledger sequence, and metadata.

These fixtures are intended purely for local development/demo purposes so the frontend has data to render out of the box; they are not used in automated tests.

### Troubleshooting

If a `prisma generate` / `prisma migrate` command misbehaves, check `prisma.config.ts` before assuming the schema is at fault:

- **"Environment variable not found: DATABASE_URL"** or the CLI connecting to the wrong database — the config resolves `DATABASE_URL` at load time via `dotenv/config`, so it reads `backend/.env`. A variable exported only in your shell after the process starts, or set in a `.env` outside `backend/`, will not be picked up.
- **CLI can't find the schema or migrations** — these paths are relative to `backend/`. Running `prisma` from the repo root will not resolve them.
- **`npm run prisma:seed` not running the seed script** — the seed command is declared in the legacy `prisma.seed` field in `package.json`. Prisma 7 expects it as `migrations.seed` in `prisma.config.ts`, so if seeding silently does nothing, check both places.

## /v1 API

All REST API endpoints are prefixed with `/v1`. Refer to the API Documentation in the root `README.md` and the `docs/` folder for versioning and authentication details.

## Server-Sent Events (SSE)

The backend exposes an SSE endpoint (`/v1/streams/events`) to stream real-time updates to the frontend whenever on-chain stream events are indexed.

## Indexer Startup Preflight

Before the Soroban event worker begins polling, the indexer runs a preflight that validates the configured deployment identity. If any check fails, the worker does not start and no cursor or stream state is read or written — the process fails fast with an actionable diagnostic instead of indexing the wrong deployment.

The preflight verifies, in order:

1. **Network** — `STELLAR_NETWORK` / `NETWORK_PASSPHRASE` is present, well-formed, and matches the network the RPC endpoint reports. A missing, malformed, or mismatched network aborts startup.
2. **Contract ID** — `STREAM_CONTRACT_ID` is present, is a valid Stellar contract address (`C...`), and corresponds to the expected deployment for the configured network. A missing, malformed, or mismatched contract ID aborts startup.
3. **RPC availability** — the configured `SOROBAN_RPC_URL` (and any `SOROBAN_RPC_URLS` failover endpoints) is reachable and responds to a health probe. An unreachable RPC aborts startup with the failing endpoint in the message.
4. **Contract interface compatibility** — the deployed contract exposes the methods and events the indexer expects. A missing or incompatible interface aborts startup.

Each failure is reported with the specific check that failed and the offending value, so operators can correct configuration without inspecting logs. Because preflight runs before the worker touches the database, a failed preflight leaves the indexer cursor and stream state untouched; fixing the configuration and restarting resumes from the previous cursor.

Operational impact: a misconfigured deployment now fails at startup rather than silently indexing the wrong network or contract. No migration is required — existing valid configurations pass preflight unchanged, and the public indexer interfaces are preserved.

## Blue-Green Database Connection Cutover

During database maintenance (major version upgrades, storage migrations, or region moves) operators can move application instances from a **blue** (current) endpoint to a **green** (target) endpoint without ever routing writes to an unverified target. The cutover is driven entirely by `DATABASE_URL`; no application code path changes and the public API contract is unchanged.

### Readiness checks (run before routing any writes)

A target endpoint is only eligible for cutover once **all** of the following pass:

1. **Reachability** — the green endpoint accepts TCP connections and completes a TLS handshake (if required).
2. **Authentication & schema** — `DATABASE_URL` for green authenticates and `npx prisma migrate status` reports no pending migrations (the green schema must match the blue schema before cutover).
3. **Read probe** — a read-only query (e.g. `SELECT 1` plus a count against a known table) succeeds within the connection timeout.
4. **Replication lag** — if green is a replica promoted for cutover, lag is at or near zero so no committed writes are lost.
5. **Worker quiescence** — the Soroban event worker is paused (see below) so no in-flight poll batch writes to blue while green is being verified.

If any check fails, **do not** flip `DATABASE_URL`. The blue endpoint remains authoritative and the cutover is aborted.

### Worker and API behavior during cutover

- **API** — in-flight requests complete against blue. New requests continue to be served from blue until the process is restarted with the green `DATABASE_URL`; there is no partial switch where some requests write to blue and others to green.
- **Worker** — pause the worker before verification so no new poll batches start. Any batch already in flight is allowed to finish (its cursor write lands on blue). After the restart with green, the worker resumes from the persisted cursor, so no events are skipped or double-indexed.
- **Connection re-establishment** — the Prisma client is created at process start from `DATABASE_URL`; a cutover therefore requires a rolling restart of API and worker processes. Old connections to blue are drained by the orchestrator; new connections go to green.

### Operator commands

```bash
# 1. Pause the worker (stop new poll batches; in-flight batch drains)
kubectl scale deploy/flowfi-worker --replicas=0

# 2. Verify the green endpoint is ready (all readiness checks above)
export DATABASE_URL="$GREEN_DATABASE_URL"
npx prisma migrate status          # must report "Database schema is up to date"
psql "$DATABASE_URL" -c 'SELECT 1;' # read probe

# 3. Cut over: point API + worker at green and roll restart
kubectl set env deploy/flowfi-api    DATABASE_URL="$GREEN_DATABASE_URL"
kubectl set env deploy/flowfi-worker DATABASE_URL="$GREEN_DATABASE_URL"
kubectl rollout restart deploy/flowfi-api deploy/flowfi-worker
kubectl rollout status  deploy/flowfi-api deploy/flowfi-worker

# 4. Resume the worker
kubectl scale deploy/flowfi-worker --replicas=1
```

### Rollback

Rollback is the same procedure in reverse and is safe as long as green has not accepted writes that blue lacks:

```bash
kubectl scale deploy/flowfi-worker --replicas=0
kubectl set env deploy/flowfi-api    DATABASE_URL="$BLUE_DATABASE_URL"
kubectl set env deploy/flowfi-worker DATABASE_URL="$BLUE_DATABASE_URL"
kubectl rollout restart deploy/flowfi-api deploy/flowfi-worker
kubectl rollout status  deploy/flowfi-api deploy/flowfi-worker
kubectl scale deploy/flowfi-worker --replicas=1
```

**Rollback triggers:** any readiness check failing after the flip, elevated 5xx or connection errors on the API, worker cursor errors, or replication divergence. If green has accepted writes, reconcile them back to blue before rolling back rather than discarding them.

### Failure and boundary cases

- **Target unreachable** — readiness check 1 fails; cutover aborts, blue stays authoritative.
- **Pending migrations on green** — readiness check 2 fails; run migrations on green first, then re-verify.
- **Partial cutover** (API flipped, worker not yet restarted) — the worker keeps writing to blue until its own restart; pause it first to avoid split writes, and roll back the API if verification fails.
- **Rollback path** — reverse the env change and restart; the worker resumes from the persisted cursor on blue.

## Logging & Correlation IDs

Structured JSON logs generated by Winston (`backend/src/logger.ts`) attach a `requestId` correlation ID via `AsyncLocalStorage` (`requestContext`):
- **HTTP Requests:** Set via `requestIdMiddleware` (`X-Request-ID` header or auto-generated UUID).
- **Worker Poll Batches:** Each poll cycle in `SorobanEventWorker` runs in `requestContext.run({ requestId: randomUUID() }, ...)` so all event logs and error traces share a single ID per cycle.
- **Admin Replays:** Replays triggered via `repl

/* … truncated 174 chars — edit only what you need near the top … */
