# Indexer Operations Guide

This document describes the externally observable behavior of the indexer's
lease coordination, the database indexes backing stream/event reads, the
admin replay preview/execute contract, the Soroban RPC retry/backoff policy,
graceful shutdown and poll cancellation, the ledger-consistent snapshot
endpoint, and the indexer metrics. It is written for operators and on-call
engineers. All public interfaces described here are additive; existing
endpoints and configuration keys keep working unless noted.

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
- **Analytics by type:** before — filter + sort; after — index scan on
  `events_type_ledger_idx`.

### Operational impact

- Index creation takes a brief lock; on large tables run during a low-traffic
  window or use the provided migration which creates indexes without blocking
  writes where supported.
- Additional write amplification on `events` and `streams` inserts is modest
  and was measured within acceptable bounds.
- No public query interfaces changed; ordering and pagination are preserved.

---

## 3. Admin replay: preview and execution

### Contract

Replay is exposed under the existing admin replay controls. Two operations:

- **Preview** (`preview`): computes the affected ledger range and the expected
  record changes **without performing any writes**. Safe to call repeatedly.
- **Execute** (`execute`): performs the replay and returns an execution report.
  Supports retry.

Both accept the same replay parameters as before (ledger range / target). The
response is a **report** with the following fields:

| Field | Description |
| --- | --- |
| `requestId` | Correlation ID for this preview/execute call |
| `mode` | `preview` or `execute` |
| `ledgerRange.from` / `ledgerRange.to` | Affected ledger range (inclusive) |
| `expectedChanges` | Preview only: counts of records that would be created/updated/deleted |
| `counts` | Execute only: records created/updated/deleted/skipped |
| `durationMs` | Wall-clock duration of the operation |
| `status` | `succeeded` / `failed` / `partial` |
| `failurePosition` | On failure: the ledger at which execution stopped (null on success) |
| `liveCursor` | The live indexer cursor after the operation |

### Guarantees

- **Preview performs no writes.** It is read-only and reproducible.
- **Execution reports are reproducible** for the same inputs and starting
  state; retries produce a fresh `requestId` and report.
- **Live cursor is preserved on failure.** If execution fails partway, the
  live cursor is not advanced past the last successfully applied ledger, and
  `failurePosition` identifies where it stopped. Retry resumes from there.

### Concurrency: replay vs. live polling

Replay, reset, and normal polling all mutate the same shared cursor and event
state, so they are **serialized** against each other. The serialization is
enforced at the database layer (a transaction-scoped advisory lock keyed on the
indexer cursor row), not in process memory, so it holds **across multiple
backend instances**.

- **Mutual exclusion.** While a replay (or reset) holds the lock, the live
  worker cannot advance the cursor; while the live worker holds it, replay
  waits. Operations queue rather than interleave.
- **Monotonic cursor.** The cursor never moves backwards as a result of a
  replay overlapping a poll. A replay that would move the cursor behind the
  live position is rejected (reported as `status: failed` with a clear
  message) instead of silently rewinding it.
- **Deterministic event state.** Because replay and polling never run
  concurrently, the resulting event state for a given starting state and
  inputs is deterministic regardless of which replica handled the poll or the
  replay.
- **Fencing still applies.** A replay executed by a replica that does not hold
  the lease is rejected by the same fencing check that guards cursor writes.

---

## 4. Ledger-consistent multi-resource snapshots

### Contract

The snapshot endpoint returns related **stream**, **event**, and **balance**
data tied to a single indexed ledger checkpoint, so clients never have to
stitch together results read at different ledger heights.

- **Single checkpoint.** All resources in a response are read at the same
  indexed ledger. The response echoes that ledger as `ledger`.
- **Staleness metadata.** The response includes `indexerLag` (current chain
  head minus the snapshot ledger) and `stale` (whether the snapshot is older
  than the configured freshness threshold).
- **No checkpoint yet.** If the indexer has not yet indexed any ledger, the
  endpoint returns a `409`-style "no checkpoint" result rather than an empty
  snapshot; clients should retry after the indexer catches up.

### Response fields

| Field | Description |
| --- | --- |
| `ledger` | The indexed ledger checkpoint the snapshot was read at |
| `indexerLag` | Ledgers between the chain head and `ledger` (0 when caught up) |
| `stale` | `true` when `indexerLag` exceeds the freshness threshold |
| `streams` | Stream records as of `ledger` |
| `events` | Event records as of `ledger` |
| `balances` | Balance records as of `ledger` |

### Client retry semantics

When the indexer is lagging, clients **must retry** rather than combine
results from different ledgers:

- If `stale` is `true`, treat the snapshot as advisory and retry with backoff
  until a fresher snapshot is available; do **not** merge it with data from
  another request.
- If the endpoint reports no checkpoint yet, retry after a short delay.
- A snapshot is internally consistent by construction; combining resources
  across two snapshot responses read at different `ledger` values is not
  supported and can produce inconsistent views.

### Boundary cases

- **Zero lag:** `indexerLag` is `0` and `stale` is `false` when the indexer is
  caught up to the chain head.
- **Large lag:** `indexerLag` grows with the gap; `stale` flips to `true` once
  the threshold is exceeded.
- **No checkpoint:** the endpoint signals retry instead of returning partial
  data.

---

## 5. Soroban RPC retry and backoff

### Behavior

Soroban RPC calls are retried with bounded exponential backoff and jitter.

- **Retryable errors.** Transient transport failures, timeouts, and rate-limit
  responses are retried. Deterministic errors (invalid arguments, not found)
  are not retried.
- **Bounded attempts.** Each call has a maximum attempt count and a cap on the
  backoff delay; jitter avoids synchronized retry storms across replicas.
- **Cursor safety.** A failed poll does not advance the cursor; the next poll
  resumes from the last successfully applied ledger.

### Configuration

| Key | Meaning | Notes |
| --- | --- | --- |
| `SOROBAN_RPC_MAX_ATTEMPTS` | Maximum attempts per call | Includes the first attempt |
| `SOROBAN_RPC_BASE_BACKOFF_MS` | Base backoff delay | Grows exponentially per attempt |
| `SOROBAN_RPC_MAX_BACKOFF_MS` | Backoff cap | Upper bound after jitter |

---

## 6. Graceful shutdown and poll cancellation

### Behavior

On shutdown the indexer stops accepting new work, cancels any in-flight poll,
and releases the lease so another replica can take over promptly.

- **Cancellation.** An in-flight poll observes the shutdown signal and aborts
  before advancing the cursor; partially applied work is not committed.
- **Lease release.** The lease is released on shutdown so takeover latency is
  not bounded by the TTL.
- **Idempotent restart.** Because the cursor only advances on committed work,
  a restart resumes from the last applied ledger without duplication.

---

## 7. Metrics

| Metric | Meaning |
| --- | --- |
| `indexer_lease_acquired_total` | Successful lease acquisitions |
| `indexer_lease_renewed_total` | Successful lease renewals |
| `indexer_lease_lost_total` | Lease losses (expiry or renewal failure) |
| `indexer_fenced_write_rejected_total` | Cursor writes rejected by fencing |
| `indexer_poll_duration_ms` | Poll duration histogram |
| `indexer_cursor_ledger` | Current indexed ledger |
| `indexer_lag_ledgers` | Chain head minus indexed ledger |
| `indexer_snapshot_stale_total` | Snapshots served while stale |
