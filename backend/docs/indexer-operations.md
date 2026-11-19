# Indexer Operations Guide

This document describes the externally observable behavior of the indexer's
lease coordination, the database indexes backing stream/event reads, the
admin replay preview/execute contract, the Soroban RPC retry/backoff policy,
graceful shutdown and poll cancellation, the indexer metrics, the
blue-green database connection cutover procedure, and the multi-region read
failover runbook. It is written for operators and on-call engineers. All
public interfaces described here are additive; existing endpoints and
configuration keys keep working unless noted.

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
- **Fencing still applies.** The advisory lock is layered on top of the lease
  fencing described in §1; a stale owner cannot advance the cursor even if it
  somehow acquires the lock.

---

## 4. Multi-region read failover runbook

This section covers failing **read traffic** over between regional
deployments while preserving network identity and making stale data visible.
Writes are **not** failed over (see §4.5).

### 4.1 Topology and network identity

- Each region runs a full backend deployment (API + read replica of the
  primary database) behind a regional load balancer.
- A global DNS/edge layer routes read traffic to the **active read region**.
  The active region is a single named target; clients always resolve the same
  hostname, so **network identity (hostname, TLS certificate, and API base
  URL) is preserved** across failover. No client reconfiguration is required.
- The **primary region** owns writes and the indexer lease (§1). Secondary
  regions serve reads from their replica only.

### 4.2 Promotion conditions (secondary → active read region)

Promote a secondary region to serve reads only when **all** of the following
hold:

1. **Primary read health degraded beyond threshold.** Primary read error rate
   exceeds the configured threshold (default: > 5% of read requests over a
   5-minute window) **or** primary read p99 latency exceeds the threshold
   (default: > 2s over 5 minutes), sustained for at least two consecutive
   evaluation windows.
2. **Replication lag within bound.** The candidate secondary's replication lag
   is at or below the configured bound (default: ≤ 30s behind primary).
3. **Secondary verified healthy.** The candidate secondary passes its read
   health check (error rate and latency within thresholds) and can reach its
   replica.

If any condition is unmet, do **not** promote; keep serving from the current
active region and escalate.

### 4.3 Rollback conditions (active read region → primary)

Roll back to the primary region when **either**:

1. **Primary recovered and stable.** Primary read health has been within
   thresholds for at least the configured stability window (default: 10
   minutes), **or**
2. **Secondary serving stale data beyond tolerance.** The active secondary's
   replication lag exceeds the stale-data tolerance (default: > 60s) — reads
   are more correct from a recovered primary than from a badly lagged
   secondary.

Rollback uses the same DNS/edge switch, so network identity is preserved.

### 4.4 Simulated regional loss rehearsal

Rehearse quarterly (and before any topology change) using the following
scripted scenario in a non-production environment:

1. **Baseline.** Confirm primary is active read region; record read error
   rate, p99 latency, and secondary replication lag.
2. **Inject loss.** Block read traffic to the primary region (firewall/edge
   rule) to simulate regional loss. Do **not** stop the primary database.
3. **Observe promotion.** Expect: primary read health crosses threshold →
   promotion conditions evaluated → secondary promoted → DNS/edge switch →
   clients continue hitting the same hostname. Record time-to-promote.
4. **Verify stale-data visibility.** Confirm responses from the secondary
   carry the staleness signal (§4.6) and that the reported lag matches the
   observed replication lag.
5. **Restore primary.** Remove the block; wait for the stability window.
6. **Observe rollback.** Expect rollback to primary once stable; confirm
   network identity unchanged and staleness signal cleared.

Record the rehearsal outcome (time-to-promote, time-to-rollback, any
threshold breaches) in the operations log.

### 4.5 Consistency limitations for writes during failover

- **No cross-region write failover.** Writes continue to target the primary
  region only. If the primary is truly lost (not just read-degraded), writes
  fail until the primary recovers; this runbook does not promote a secondary
  to accept writes.
- **Read-after-write anomalies.** A client that writes to the primary and
  immediately reads from a promoted secondary may not see its own write until
  replication catches up (bounded by the replication lag at promotion time).
- **Replication lag window.** Reads served by a secondary reflect the primary
  as of up to the lag bound (default 30s) in the past. Data newer than that
  window may be missing from secondary reads.
- **Indexer cursor.** The indexer lease remains on the primary; secondary
  reads may lag the live cursor by the replication lag.

### 4.6 Surfacing stale data to clients

When reads are served by a non-primary region, responses include a staleness
signal so clients can decide whether to retry against the primary or tolerate
the lag:

- A response header (e.g. `X-Data-Staleness-Seconds`) reporting the current
  replication lag in seconds, and
- A boolean flag (e.g. `X-Read-From-Secondary: true`) indicating the response
  came from a secondary region.

When serving from the primary, the staleness header is `0` and the secondary
flag is absent/false. These are additive headers; existing clients that ignore
unknown headers are unaffected.

### 4.7 Checks and automated coverage

Focused automated coverage validates the failover decision logic:

- **Promotion:** promotes when primary is degraded, lag is within bound, and
  secondary is healthy.
- **Failure — primary unavailable:** promotion proceeds when primary read
  health is fully unavailable (treated as degraded).
- **Failure — replication lag exceeded:** promotion is refused when the
  candidate secondary's lag exceeds the bound.
- **Boundary — lag exactly at threshold:** lag equal to the bound is treated
  as within bound (promotes).
- **Boundary — partial recovery:** rollback is refused while primary health is
  recovering but has not yet met the stability window.
- **Rollback — stale secondary:** rollback triggers when the active secondary's
  lag exceeds the stale-data tolerance.

---

## 5. Soroban RPC retry and backoff

*(unchanged — see existing sections below)*
