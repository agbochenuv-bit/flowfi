# Backend observability

Prometheus metrics and OpenTelemetry tracing for the FlowFi backend.

## Metrics

`GET /metrics` renders the registry in the standard Prometheus text exposition
format.

### Access control

The endpoint is **deny-by-default in production**. It is enabled when either
guard is configured; each guard is skipped when it is not set, so configuring a
single one is enough:

| Variable | Effect |
| --- | --- |
| `METRICS_BEARER_TOKEN` | Prometheus must send `Authorization: Bearer <token>` |
| `METRICS_ALLOWED_CIDRS` | Comma-separated CIDRs the scraper must originate from, e.g. `10.0.0.0/8,fd00::/8` |

With neither set the endpoint returns **404** in production and is open in
development/test so local scrapes work with no configuration.

When **both** are configured a request must satisfy **both**. That is
deliberate defence in depth: a leaked scrape token is then worthless from
outside the monitoring network. Operators who want either-or should configure a
single mechanism.

`/metrics` is exempt from the global rate limiter — a 429 would make Prometheus
mark the target down and blind the whole alerting pipeline. The route is
protected by its own network/token guard instead.

Prometheus scrape config:

```yaml
scrape_configs:
  - job_name: flowfi-backend
    metrics_path: /metrics
    static_configs:
      - targets: ['backend:3001']
    authorization:
      type: Bearer
      credentials: <METRICS_BEARER_TOKEN>
```

### Exported metrics

| Metric | Type | Labels | Meaning |
| --- | --- | --- | --- |
| `flowfi_indexer_current_ledger` | Gauge | — | Last ledger fully indexed |
| `flowfi_indexer_network_ledger` | Gauge | — | Latest ledger on the network |
| `flowfi_indexer_lag_ledgers` | Gauge | — | `network - current` |
| `flowfi_indexer_polls_total` | Counter | `outcome` | Poll cycles: `processed` / `empty` / `rpc_error` |
| `flowfi_indexer_events_processed_total` | Counter | `eventType`, `result` | Events dispatched: `processed` / `quarantined` |
| `flowfi_sse_active_connections` | Gauge | `topic` | Live SSE clients. `topic="total"` is the reserved aggregate |
| `flowfi_sse_max_connections` | Gauge | — | Configured SSE ceiling |
| `flowfi_sse_connections_total` | Counter | — | Clients accepted since start |
| `flowfi_sse_clients_dropped_total` | Counter | `reason` | `slow_client` / `capacity` / `per_ip_limit` |
| `flowfi_rpc_request_duration_seconds` | Histogram | `method` | Outbound Soroban RPC latency |
| `flowfi_rpc_requests_total` | Counter | `method`, `outcome` | `success` / `error` / `timeout` |
| `flowfi_rpc_failovers_total` | Counter | `method` | Retries issued after a failed attempt |
| `flowfi_rpc_circuit_breaker_trips_total` | Counter | `endpoint`, `method` | Calls that hit the deadline or exhausted retries |
| `flowfi_db_query_duration_seconds` | Histogram | `operation` | Prisma/pg query latency, labelled `VERB:Table` |
| `flowfi_db_pool_connections` | Gauge | `state` | `total` / `idle` / `waiting` (legacy aggregate) |
| `flowfi_db_pool_total_connections` | Gauge | — | Live total connections held by the pg pool (sampled per scrape) |
| `flowfi_db_pool_idle_connections` | Gauge | — | Live idle connections in the pg pool (sampled per scrape) |
| `flowfi_db_pool_waiting_requests` | Gauge | — | Requests queued for a connection (sampled per scrape) |
| `flowfi_db_pool_max_connections` | Gauge | — | Configured pool ceiling |
| `flowfi_http_requests_total` | Counter | `method`, `route`, `status` | API requests |
| `flowfi_http_request_duration_seconds` | Histogram | `method`, `route` | API request latency |
| `flowfi_process_*` | — | — | Node process metrics (default collection) |

Route labels are collapsed to templates (`/streams/:id/events`), so a stream of
concrete IDs does not explode series cardinality.

### Alerting starting points

| Alert | Expression |
| --- | --- |
| Indexer falling behind | `flowfi_indexer_lag_ledgers > 60 for 5m` |
| RPC endpoint down | `rate(flowfi_rpc_circuit_breaker_trips_total[5m]) > 0` |
| SSE saturation | `flowfi_sse_active_connections{topic="total"} / flowfi_sse_max_connections > 0.8` |
| DB pool contention | `flowfi_db_pool_waiting_requests > 0 for 2m` |
| Quarantined events | `increase(flowfi_indexer_events_processed_total{result="quarantined"}[1h]) > 0` |

## Grafana

`grafana-dashboard.json` is an importable dashboard covering all of the above.
Grafana → Dashboards → Import → upload the file → pick the Prometheus
datasource. The panels use a `${DS_PROMETHEUS}` datasource variable, so the same
JSON works across staging and production.

## Tracing

OpenTelemetry NodeSDK with HTTP/Express/pg auto-instrumentation, plus explicit
spans for domain operations that instrumentation cannot infer:

| Span | Source |
| --- | --- |
| `rpc.<method>` | `sorobanService.withRpcTimeout` |
| `indexer.poll` | `SorobanEventWorker.fetchAndProcessEvents` |
| `indexer.replay_dead_letter` | `indexerService.replayDeadLetterEvent` |

| Variable | Effect |
| --- | --- |
| `OTEL_SDK_DISABLED=true` | Skip SDK initialisation entirely |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OTLP/HTTP traces endpoint. Unset → spans are dropped in-process |
| `OTEL_SERVICE_NAME` | Service name (default `flowfi-backend`) |

The SDK is initialised in `src/lib/otel.ts`, which `src/index.ts` imports first:
the auto-instrumentations patch `http`, `express` and `pg` at require time, so
anything they wrap has to load afterwards. That file also calls `dotenv.config()`
itself, because ES module imports are hoisted past the entrypoint's own
`dotenv.config()` call.

Telemetry never blocks serving: a failed SDK start logs a warning and the
process continues untraced.

## Configuration reference

| Variable | Default | Purpose |
| --- | --- | --- |
| `METRICS_BEARER_TOKEN` | — | Bearer token required on `/metrics` |
| `METRICS_ALLOWED_CIDRS` | — | CIDR allowlist for the scraper |
| `PG_POOL_METRICS_INTERVAL_MS` | `5000` | Pool gauge sampling interval |
| `SOROBAN_RPC_TIMEOUT_MS` | `10000` | Per-call RPC deadline (drives breaker trips) |
| `SOROBAN_RPC_MAX_RETRIES` | `2` | Retry budget (drives failover counts) |
| `SIMULATION_VALIDITY_LEDGERS` | `10` | Ledgers a `/simulate` footprint stays fresh for |

## Incident evidence and post-incident review

Use this template to record evidence during a production incident and to drive
the post-incident review (PIR). Copy it into the incident ticket; do not store
it in this repository. Keep the record factual and minimal — capture only what
is needed to reconstruct impact and recovery.

**Privacy:** record roles and on-call handles, not personal names, emails, or
customer identifiers. Reference streams/transactions by internal ID or hash,
never by wallet owner identity. Redact secrets, bearer tokens, and full RPC
payloads before pasting logs.

### 1. Summary

| Field | Value |
| --- | --- |
| Incident ID | |
| Severity | SEV1 / SEV2 / SEV3 |
| Status | investigating / mitigating / monitoring / resolved |
| Detected (UTC) | |
| Resolved (UTC) | |
| Incident commander (role) | |
| Comms lead (role) | |
| Affected environment | staging / production |
| Affected network | testnet / mainnet |

### 2. Impact

- User-visible symptoms and the surface affected (API, SSE stream, indexer,
  webhooks).
- Blast radius: number of streams/transactions affected, expressed as counts or
  ranges — no per-user breakdowns.
- Data integrity: was any ledger, event, or accounting record lost, duplicated,
  or mis-ordered? State yes/no and the evidence.
- Financial invariants: confirm whether balances, escrow, or settlement totals
  remained consistent. If not, link the reconciliation evidence.

### 3. Timeline (UTC)

| Time | Event | Evidence link |
| --- | --- | --- |
| | First signal / alert fired | |
| | Incident declared | |
| | Mitigation started | |
| | Service restored | |
| | Incident closed | |

### 4. Chain state

- Indexer `current_ledger` vs `network_ledger` at detection and at recovery
  (`flowfi_indexer_current_ledger`, `flowfi_indexer_network_ledger`,
  `flowfi_indexer_lag_ledgers`).
- Quarantined or dead-lettered events during the window
  (`flowfi_indexer_events_processed_total{result="quarantined"}`); list event
  IDs and replay status.
- RPC health: circuit-breaker trips and failovers per endpoint
  (`flowfi_rpc_circuit_breaker_trips_total`, `flowfi_rpc_failovers_total`).
- Any manual ledger rewind, replay, or backfill performed, with the exact
  command and the operator role that ran it.

### 5. Recovery steps

Record the ordered actions that restored service, each with the operator role
and the verification that confirmed it worked:

| # | Action | Owner (role) | Verification |
| --- | --- | --- | --- |
| 1 | | | |
| 2 | | | |

Verification must be observable (metric back in range, alert cleared, replay
count zero, smoke test green) — not "looks fine".

### 6. Follow-up work

Every follow-up item needs an owner role, a due date, and a verification
criterion so it can be closed objectively.

| # | Action item | Owner (role) | Due | Verification criterion |
| --- | --- | --- | --- | --- |
| 1 | | | | |
| 2 | | | | |

### 7. Runbooks and references

Link to the existing runbooks instead of duplicating their steps:

- Indexer operations and dead-letter replay: [`../indexer-operations.md`](../indexer-operations.md)
- Metrics, alerting, and tracing: this document (see *Alerting starting points*
  and *Tracing* above)
- Grafana dashboard: `grafana-dashboard.json` in this directory
- Architecture and event ordering: [`../ARCHITECTURE.md`](../ARCHITECTURE.md),
  [`../EVENT_ORDERING.md`](../EVENT_ORDERING.md)
