# Indexer Operations Guide

This document describes the externally observable behavior of the indexer's
lease coordination, the database indexes backing stream/event reads, the
admin replay preview/execute contract, the Soroban RPC retry/backoff policy,
graceful shutdown and poll cancellation, the indexer metrics, the
repeatable dependency-outage game days, and the long-running memory/queue
soak test. It is written for operators and on-call engineers. All public
interfaces described here are additive; existing endpoints and configuration
keys keep working unless noted.

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
- **Fencing still applies.** A r

---

## 4. Long-running memory and queue stability (soak test)

The indexer ships a repeatable soak test that drives event polling, SSE
fanout, webhook dispatch, and replay under sustained representative traffic
and asserts that memory and queue depths stay bounded. It guards against
slow resource growth (leaks, unbounded buffers, queue backlogs) that short
unit tests miss.

### What it exercises

- **Event polling** — a continuous stream of synthetic ledgers/events at a
  representative rate for the full soak window.
- **SSE fanout** — a fixed set of subscribers, including at least one **slow
  consumer** that reads below the production rate, to exercise backpressure.
- **Webhook dispatch** — deliveries to a mix of fast and slow/failing
  endpoints to exercise retry and queue bounds.
- **Replay** — a large backlog replay (including a boundary-sized range) run
  alongside live traffic to exercise the replay queue and cursor
  serialization.

### Published thresholds

The soak test fails if any of the following bounds are exceeded over the
window. Thresholds are intentionally generous to avoid flakiness on shared CI
runners while still catching unbounded growth.

| Metric | Bound | Rationale |
| --- | --- | --- |
| Heap growth (post-warmup) | ≤ 25% of baseline, and ≤ 64 MiB absolute | Catches leaks without penalizing GC jitter |
| Polling backlog depth | ≤ 1 batch (never grows across iterations) | Polling must drain each batch |
| SSE subscriber buffer depth | ≤ configured per-subscriber cap | Slow consumers are dropped/backpressured, not buffered unboundedly |
| Webhook dispatch queue depth | ≤ configured max queue size | Dispatch queue must stay bounded under slow/failing endpoints |
| Replay queue depth | ≤ 1 in-flight replay | Replay is serialized against polling |
| Dropped/evicted SSE subscribers | counted, not unbounded | Slow consumers are evicted rather than accumulating |

### Failure and boundary cases covered

- **Queue saturation** — traffic is driven above the drain rate to confirm
  queues cap out and shed load instead of growing without bound.
- **Slow consumers** — a subscriber that reads slowly must be backpressured
  or evicted; its buffer must not grow past the cap.
- **Large backlog replay** — replaying a boundary-sized ledger range must
  complete with bounded memory and must not advance the live cursor past the
  last applied ledger on failure.

### Reproduction

Run the soak test from the backend package. It is opt-in (not part of the
fast unit suite) so it does not slow normal CI:

```bash
cd backend
# Default soak window (short, CI-friendly)
npm run test:soak

# Longer local soak window (e.g. 5 minutes)
SOAK_DURATION_MS=300000 npm run test:soak
```

Environment knobs:

| Variable | Meaning | Default |
| --- | --- | --- |
| `SOAK_DURATION_MS` | Soak window length | Short CI-friendly default |
| `SOAK_EVENT_RATE` | Synthetic events per second | Representative production rate |
| `SOAK_SSE_SUBSCRIBERS` | Number of SSE subscribers | Small fixed set |
| `SOAK_WEBHOOK_ENDPOINTS` | Number of webhook endpoints | Small fixed set |

If a threshold is exceeded, the test reports the offending metric, its
observed value, and the bound so the regression can be triaged. Thresholds
and reproduction steps above are the published contract for this test; update
them here if the bounds change.
