# Indexer Operations Guide

This document describes the externally observable behavior of the indexer's
lease coordination, the database indexes backing stream/event reads, the
admin replay preview/execute contract, the Soroban RPC retry/backoff policy,
graceful shutdown and poll cancellation, the read-replica consistency and
routing policy, the RPC provider cost/quota visibility, and the indexer
metrics. It is written for operators and on-call engineers. All public
interfaces described here are additive; existing endpoints and configuration
keys keep working unless noted.

---

## 0. Read-replica consistency and routing policy

### Routing defaults

API reads are routed by an explicit policy. Each read is classified as either
**replica-eligible** or **primary-only**. The default is conservative: reads
that are not explicitly classified as replica-eligible go to the primary.

| Read class | Default route | Rationale |
| --- | --- | --- |
| Authorization / auth-sensitive reads (session, wallet ownership, admin checks) | **Primary** | Must never observe stale authorization state |
| Read-after-write (a client reading data it just wrote) | **Primary** | Preserves read-your-writes for the caller |
| Financial accounting reads (balances, ledger-derived totals) | **Primary** | Accounting invariants require the authoritative ledger |
| Chain/network validation reads | **Primary** | Validation must see the canonical chain state |
| Public list/history/analytics reads (streams, events, pagination) | **Replica** (when a replica is configured and caught up) | Tolerant of bounded lag; documented below |

When no replica is configured, or the replica is behind the required ledger,
replica-eligible reads transparently fall back to the primary. Callers see no
interface change.

### Freshness requirement and lag measurement

The indexer cursor records the last fully applied ledger. A replica is
considered **caught up** when its observed cursor is at or beyond the
**required ledger** for the read:

- For replica-eligible reads the required ledger is the current primary
  cursor minus the configured tolerance (`REPLICA_MAX_LAG_LEDGERS`).
- Reads that require the latest ledger (read-after-write, accounting,
  authorization, validation) always require the primary cursor and are never
  served from a replica.

Lag is measured as `primaryCursor - replicaCursor` in ledgers. A replica whose
lag exceeds the tolerance is treated as **behind**.

### Informing clients when a replica is behind

Replica-eligible reads that cannot be served within tolerance fall back to the
primary, so responses stay correct. To make staleness observable without
breaking existing clients, responses served from a replica include an additive
header:

| Header | Meaning |
| --- | --- |
| `X-Read-Source` | `primary` or `replica` |
| `X-Replica-Lag-Ledgers` | Observed lag in ledgers when served from a replica |

If a caller explicitly requests replica routing (opt-in) and the replica is
behind the required ledger, the request is served from the primary and the
headers above reflect `primary`. Existing response bodies and status codes are
unchanged; the headers are additive and safe to ignore.

### Failover

- If the replica is unreachable or errors, replica-eligible reads fail over to
  the primary. Failover is logged and counted (see metrics).
- If the primary is unavailable, primary-only reads fail with the existing
  error contract; they are **never** silently served from a stale replica.
- On replica promotion/failover, the new primary is authoritative; routing
  policy is unchanged and lag is recomputed against the new primary cursor.

### Configuration

| Key | Meaning | Notes |
| --- | --- | --- |
| `REPLICA_DATABASE_URL` | Read-replica connection | Unset disables replica routing |
| `REPLICA_MAX_LAG_LEDGERS` | Max tolerated lag for replica-eligible reads | Defaults are conservative |
| `REPLICA_ROUTING_ENABLED` | Master switch for replica routing | Defaults to off until a replica is provisioned |

### Guarantees preserved

Replica routing never weakens wallet authorization, chain/network validation,
financial accounting invariants, or secret handling: those reads are
primary-only by policy and are not eligible for replica routing.

---

## 0.1 RPC provider cost and quota visibility

The indexer talks to Soroban RPC providers. To let operators manage
availability and cost, the indexer exposes **aggregate** RPC provider metrics
grouped by network. Metrics never include request bodies, headers, API keys,
URLs with credentials, or any other request secret.

### Metrics

All metrics are counters or gauges labeled by `network` (e.g. `testnet`,
`mainnet`) and `provider` (a stable, non-secret provider identifier such as
`primary` or `fallback-a`). Provider identifiers are configured names, never
raw URLs or keys.

| Metric | Type | Meaning |
| --- | --- | --- |
| `rpc_requests_total` | counter | RPC requests attempted, by `network`, `provider`, `method` |
| `rpc_request_errors_total` | counter | Failed RPC requests, by `network`, `provider`, `outcome` |
| `rpc_quota_exhausted_total` | counter | Requests rejected because the provider quota was exhausted |
| `rpc_quota_remaining` | gauge | Remaining quota reported by the provider, when available |
| `rpc_failover_total` | counter | Failovers from one provider to another, by `network`, `from`, `to`, `reason` |
| `rpc_failover_outcome_total` | counter | Result of a failover attempt, by `network`, `outcome` (`success`/`failure`) |
| `rpc_latency_seconds` | histogram | Request latency, by `network`, `provider` |

`outcome` values are bounded (`success`, `error`, `quota_exhausted`,
`timeout`). Labels are bounded to configured networks and providers; no
per-request or per-caller identifiers are emitted.

### Quota transitions

A provider moves through these states per network:

1. **Available** — requests succeed; `rpc_quota_remaining` reflects the
   provider's reported headroom when available.
2. **Exhausted** — the provider returns a quota/rate-limit rejection. The
   request is counted in `rpc_quota_exhausted_total`, the provider is marked
   exhausted for the current window, and subsequent requests fail over to the
   next configured provider.
3. **Recovered** — once the quota window resets (or the provider reports
   headroom again), the provider returns to **Available** and is eligible for
   routing again.

Transitions are logged at `warn` (exhausted) and `info` (recovered) with the
network and provider identifier only. Quota state is per network; exhausting
one network's provider does not affect another network.

### Failover outcomes

When a provider is exhausted or errors, the indexer fails over to the next
configured provider for that network. Each attempt increments
`rpc_failover_total` and its result increments `rpc_failover_outcome_total`.
If all providers for a network are exhausted, requests fail with the existing
error contract; the indexer does not silently weaken chain/network validation
or secret handling to keep serving.

### Provider-specific limits and alerting

Configure per-provider limits so the indexer can fail over before hard
rejection. Limits are provider-specific; consult each provider's plan.

| Key | Meaning | Notes |
| --- | --- | --- |
| `RPC_PROVIDERS` | Ordered provider list per network | Names only; credentials via secret store |
| `RPC_PROVIDER_QUOTA_LIMIT` | Requests per window per provider | Provider-specific; see plan |
| `RPC_PROVIDER_QUOTA_WINDOW_MS` | Quota window length | Match the provider's reset window |
| `RPC_QUOTA_WARN_RATIO` | Fraction of quota that triggers a warning | Defaults conservatively |

Recommended alerts:

- **Quota warning:** `rpc_quota_remaining / RPC_PROVIDER_QUOTA_LIMIT` below
  `RPC_QUOTA_WARN_RATIO` for a sustained period — page the on-call owner.
- **Quota exhausted:** any increase in `rpc_quota_exhausted_total` — page;
  indicates active failover.
- **Failover failure:** any increase in `rpc_failover_outcome_total{outcome="failure"}`
  — page; a network may be unable to serve requests.
- **Error rate:** sustained `rpc_request_errors_total` growth per provider —
  investigate provider health.

Alerts must reference only `network` and `provider` labels; never include
request contents or credentials in alert annotations.

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

- **Stream list (keyset pagination):** be
