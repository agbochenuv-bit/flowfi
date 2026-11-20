# Indexer Operations Guide

This document describes the externally observable behavior of the indexer's
lease coordination, the database indexes backing stream/event reads, the
admin replay preview/execute contract, the Soroban RPC retry/backoff policy,
graceful shutdown and poll cancellation, and the indexer metrics. It is
written for operators and on-call engineers. All public interfaces described
here are additive; existing endpoints and configuration keys keep working
unless noted.

---

## 0. Field-level privacy and retention inventory

This inventory maps every wallet-linked field family the indexer touches to
its data store, purpose, retention rule, deletion constraint, and owner. It
exists so product and operations changes can be reviewed consistently against
the same privacy and retention expectations. Field families are grouped by the
store that holds them; each row links to the owning policy.

### Field families

| Field family | Data store | Purpose | Retention rule | Deletion constraint | Owner | Policy |
| --- | --- | --- | --- | --- | --- | --- |
| `wallet_address` (sender/recipient) | `streams`, `events` tables | Stream/event indexing and per-wallet history | Retained for the life of the indexed ledger record; no TTL | Cannot be deleted while the stream is referenced by an event; deletion requires a replay/reset of the affected ledger range | Indexer team | `SECURITY.md` (data handling) |
| `stream_id`, `event_id` | `streams`, `events` tables | Cursor advancement and replay targeting | Retained with the parent record | Deleted only via ledger-range replay/reset; never orphaned | Indexer team | `SECURITY.md` (data handling) |
| `cursor` / `fencing_token` | `indexer_cursor` table | Lease coordination and monotonic progress | Retained indefinitely (operational state) | Not user-deletable; reset only through the admin reset path | Indexer team | `SECURITY.md` (data handling) |
| Request/owner identifiers | Application logs | Debugging, lease and replay auditing | Rotated per log retention window; no wallet addresses in log lines | Log lines are append-only; redaction happens at write time | Platform/on-call | `SECURITY.md` (logging) |
| Aggregate event counts | Analytics store | Analytics by event type and ledger range | Aggregated only; no raw wallet addresses | Aggregates are not individually deletable; recomputed from source | Analytics owner | `SECURITY.md` (analytics) |
| Exported stream/event rows | Operator exports | Reconciliation and support | Export lifetime is operator-controlled; exports inherit source retention | Exports must be deleted when the source ledger range is reset | Operations | `SECURITY.md` (exports) |
| Webhook payloads (wallet-linked) | Webhook delivery logs | Delivery retry and audit | Retained for the webhook retry window, then purged | Cannot be edited; purged on window expiry or on source reset | Integrations owner | `SECURITY.md` (webhooks) |
| Database backups | Backup storage | Disaster recovery | Retained per the backup retention schedule | Backups are immutable; deletion follows the backup expiry schedule, not per-record requests | Platform/on-call | `SECURITY.md` (backups) |

### Review rules

- Every new wallet-linked field family **must** be added to this table with a
  store, purpose, retention rule, deletion constraint, owner, and policy link
  before it ships.
- A field family with a missing owner, policy, or retention rule is treated as
  a review failure and blocks the change.
- Unknown or empty field families are not silently dropped; they are recorded
  as `unclassified` and routed to the indexer team for triage.
- Retention and deletion constraints here must stay consistent with the
  wallet authorization and secret-handling requirements in `SECURITY.md`.

---

## 0.1 Partner onboarding and go-live checklist

This section gives an external integration team a verified path from zero to
production traffic. It covers credential configuration, webhook handling
validation, reconciliation testing, and production readiness. Every step is
runnable and every environment is kept strictly separate: **testnet and
production never share credentials, endpoints, or webhook secrets.**

### Environment separation

| Concern | Testnet | Production |
| --- | --- | --- |
| API base URL | `https://api.testnet.example.com` | `https://api.example.com` |
| Soroban RPC | `https://soroban-testnet.stellar.org` | Operator-provided mainnet RPC |
| Network passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| API credentials | Testnet-only key | Production key issued after go-live review |
| Webhook signing secret | Testnet-only secret | Production secret, rotated on schedule |

Rules:

- Never reuse a testnet key or webhook secret in production, and never point a
  production key at a testnet endpoint (or vice versa). The indexer rejects a
  request whose network passphrase does not match the configured network.
- Store credentials in the partner's secret manager, not in source control or
  shell history. Rotate the webhook secret on the schedule in `SECURITY.md`.

### Step 1 — Configure credentials (testnet)

```bash
# Testnet only. Do not reuse these values in production.
export PARTNER_API_BASE="https://api.testnet.example.com"
export PARTNER_API_KEY="$(secret-tool lookup service partner env testnet)"
export PARTNER_WEBHOOK_SECRET="$(secret-tool lookup service partner-webhook env testnet)"

# Verify the key is accepted and the network matches.
curl -fsS "$PARTNER_API_BASE/v1/health" \
  -H "Authorization: Bearer $PARTNER_API_KEY" | jq '{network, status}'
# Expected: {"network":"testnet","status":"ok"}
```

Failure cases to confirm before continuing:

- A missing or empty `PARTNER_API_KEY` returns `401`.
- A production key against the testnet base URL returns `403` (network
  mismatch), not a silent success.

### Step 2 — Validate webhook handling

Register a testnet webhook endpoint, then verify signature handling with a
runnable sample. The signature is computed over the raw request body with the
webhook secret; a tampered body or wrong secret must be rejected.

```bash
# Send a signed testnet webhook to your own handler.
BODY='{"event":"stream.created","stream_id":"test-1"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$PARTNER_WEBHOOK_SECRET" -hex | awk '{print $2}')

curl -fsS -X POST "https://partner.example.com/webhooks/indexer" \
  -H "Content-Type: application/json" \
  -H "X-Signature: sha256=$SIG" \
  --data "$BODY"
```

Your handler must:

- Recompute the HMAC over the **raw** body and compare in constant time.
- Return `2xx` only after the event is durably recorded (idempotent by
  `event_id`), so retries are safe.
- Reject a bad signature with `401` and a body that fails verification with
  `400`; never process an unverified payload.

Failure cases to confirm:

- A wrong `PARTNER_WEBHOOK_SECRET` yields `401` and no side effects.
- A body modified after signing yields `401`.
- A replayed `event_id` is acknowledged but not processed twice.

### Step 3 — Test reconciliation

Reconcile your records against the indexer's stream/event history for a known
ledger range, then confirm the cursor advanced monotonically.

```bash
# Pull events for a known testnet ledger range and compare counts.
curl -fsS "$PARTNER_API_BASE/v1/events?from_ledger=1000&to_ledger=1100" \
  -H "Authorization: Bearer $PARTNER_API_KEY" \
  | jq '{count: (.events | length), last_ledger: .cursor}'
```

- Totals must match your own ledger of record for the same range; a mismatch
  is a reconciliation failure and blocks go-live.
- Boundary cases: an empty range returns `count: 0` with an unchanged cursor;
  a range beyond the indexed head returns the indexed head, never a future
  ledger.

### Step 4 — Clean-environment validation (required before publication)

Before requesting production credentials, run the full flow above in a **fresh
environment** with no cached state, using only testnet credentials:

1. Provision a clean host/container with no prior config.
2. Set only the testnet variables from Step 1.
3. Run Steps 1–3 end to end and record the outputs.
4. Confirm no production secret or endpoint appears in the environment
   (`env | grep -i partner` must show testnet values only).

A go-live request is not accepted until this clean-environment run passes and
its outputs are attached to the request.

### Step 5 — Go-live checklist

- [ ] Clean-environment validation (Step 4) passed and outputs attached.
- [ ] Production credentials issued and stored in the secret manager.
- [ ] Production webhook secret set and rotation schedule recorded.
- [ ] Webhook handler verifies signatures and is idempotent by `event_id`.
- [ ] Reconciliation matches for a known production ledger range.
- [ ] Network passphrase and RPC endpoint confirmed as mainnet.
- [ ] No testnet key, secret, or endpoint present in production config.
- [ ] On-call contact and rollback plan documented.

---

## 1. Poll ownership lease

### Behavior

The indexer uses a single renewable lease stored in the database to guarantee
that **at most one backend replica actively polls and advances the cursor** at
any time.

- **Single owner.** A worker acquires the lease before polling. Only the
  current lease owner may advance the indexer cursor. Non-owners idle and
  periodically attempt acquisition.
- **Owner identity.** Each worker has a unique owner ID (hostname + process
  identity + random suffix). The lease records the current owner ID and a
  monotonically increasing **fencing token** (generation number).
- **TTL and renewal.** The lease has a finite TTL. The owner renews it on a
  heartbeat well before expiry. If renewal fails (e.g., DB unavailable), the
  worker stops advancing the cursor and releases ownership locally.
- **Takeover.** If the lease expires without renewal (owner crash, network
  partition, or shutdown), another worker may acquire it. Acquisition
  increments the fencing token.
- **Fencing.** Every cursor write is conditional on the writer still holding
  the lease at the current fencing token. A stale owner whose lease has been
  taken over will have its writes **rejected** rather than overwriting the new
  owner's progress. Rejected writes are logged and counted (see metrics).

### Externally observable effects

- At most one replica advances the cursor at a time; the cursor is monotonic
  per fencing generation.
- After an owner is lost, another replica takes over within roughly one TTL
  plus the acquisition retry interval.
- Stale writes from a former owner are discarded; they never move the cursor
  backwards or skip ledgers.

### Configuration

| Key | Meaning | Notes |
| --- | --- | --- |
| `INDEXER_LEASE_TTL_MS` | Lease time-to-live | Defaults are safe; must exceed renewal interval |
| `INDEXER_LEASE_RENEW_INTERVAL_MS` | Renewal heartbeat interval | Must be well below TTL |
| `INDEXER_LEASE_ACQUIRE_RETRY_MS` | Retry interval for non-owners | Controls takeover latency |

### Rollout and migration

- The lease table is created by migration and is additive; no existing data is
  rewritten.
- **Rolling upgrade:** during a mixed-version rollout, older replicas that do
  not participate in the lease must not run concurrently with new replicas
  against the same cursor. Recommended sequence:
  1. Apply the migration.
  2. Scale the indexer to a single replica (or stop old replicas).
  3. Deploy the lease-aware version.
  4. Scale back up; the lease ensures a single active owner.
- **Rollback:** the lease table may remain in place; older versions ignore it.
  Ensure only one replica runs if rolling back to a non-lease version.

---

## 2. Database indexes for stream and event reads

### Added indexes

The following indexes were added after profiling representative PostgreSQL
query plans for list, history, analytics, and cursor queries. Each is
migration-safe (created with `CREATE INDEX`; no data rewrite) and preserves
result ordering and pagination semantics.

| Index | Table | Columns | Hot path served |
| --- | --- | --- | --- |
| `streams_created_at_id_idx` | `streams` | `(created_at DESC, id DESC)` | Stream list ordering + keyset pagination |
| `streams_sender_idx` | `streams` | `(sender, created_at DESC)` | Per-wallet stream history |
| `events_stream_id_ledger_idx` | `events` | `(stream_id, ledger DESC)` | Per-stream event history |
| `events_ledger_idx` | `events` | `(ledger)` | Cursor scan / ledger range reads |
| `events_type_ledger_idx` | `events` | `(type, ledger DESC)` | Analytics by event type |

### Query-plan evidence

Before/after `EXPLAIN (ANALYZE, BUFFERS)` was captured for each hot path on a
representative dataset. Summary:

- **Stream list (keyset pagination):** before — sequential scan + sort;
  after — index scan on `streams_created_at_id_idx`, no sort node, stable
  ordering by `(created_at, id)`.
- **Per-wallet history:** before — filter + sort over `streams`; after —
  index scan on `streams_sender_idx`.
- **Per-stream events:** before — filter on `stream_id` then sort; after —
  index scan on `events_stream_id_ledger_idx`.
- **Cursor scan / ledger range:** before — sequential scan; after — index
  scan on `events_ledger_idx`.
