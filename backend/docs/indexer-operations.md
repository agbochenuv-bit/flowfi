# Indexer Operations Guide

This document describes the externally observable behavior of the indexer's
lease coordination, the database indexes backing stream/event reads, the
admin replay preview/execute contract, the Soroban RPC retry/backoff policy,
graceful shutdown and poll cancellation, and the indexer metrics. It is
written for operators and on-call engineers. All public interfaces described
here are additive; existing endpoints and configuration keys keep working
unless noted.

---

## 0. Multi-network deployment decision guide

This section explains how operators select and verify the **network, contract,
token, endpoint, and release artifact** combination for each environment. It is
the first thing to read before deploying or promoting a release. The values
below are verified against the current deployment configuration
(`.github/workflows/deploy-contracts.yml`, the testnet e2e config, and the
backend env example); if those files change, update this guide in the same PR.

### 0.1 Environments and their fixed combinations

Each environment pins a single, consistent combination. Never mix values from
different rows.

| Environment | Network / passphrase | Contract source | Token | RPC / Horizon endpoint | Release artifact |
| --- | --- | --- | --- | --- | --- |
| `local` | `Standalone` (`Standalone Network ; February 2017`) | built from working tree | locally issued test token | `http://localhost:8000/soroban/rpc`, `http://localhost:8000` | none (source build) |
| `testnet` | `Test SDF Network ; September 2015` | deployed by `deploy-contracts.yml` | testnet token from deploy output | `https://soroban-testnet.stellar.org`, `https://horizon-testnet.stellar.org` | tagged release artifact |
| `mainnet` | `Public Global Stellar Network ; September 2015` | deployed by `deploy-contracts.yml` (protected env) | mainnet token from deploy output | `https://soroban-mainnet.stellar.org`, `https://horizon.stellar.org` | tagged release artifact |

Rules that follow from the table:

- **Network passphrase is authoritative.** The backend must be configured with
  the passphrase matching the RPC endpoint. A mismatch causes signature
  verification to fail; do not "fix" it by disabling validation.
- **Contract and token IDs are per-network.** A contract ID from testnet is
  meaningless on mainnet. Always take contract and token IDs from the deploy
  output of the *same* environment.
- **Endpoints are per-network.** RPC and Horizon must both point at the same
  network. Mixing a testnet RPC with a mainnet Horizon URL is a misconfiguration.
- **Release artifacts are immutable.** Promote the exact artifact that was
  built and tested for the target network; do not rebuild during promotion.

### 0.2 Preflight checklist

Run through this checklist before every deploy or promotion. Each item maps to
an automated check where one exists.

1. **Network passphrase** matches the target environment (see table).
2. **RPC endpoint** host matches the network (testnet vs mainnet host).
3. **Horizon endpoint** host matches the same network as the RPC endpoint.
4. **Contract ID** was produced by the deploy run for this environment and is
   present in the deploy output / env file.
5. **Token contract ID** comes from the same deploy output as the contract ID.
6. **Release artifact** is the tagged artifact built for this network; its
   checksum matches the published release.
7. **Secrets** (deployer key, admin key) are provided by the environment's
   secret store — never committed and never copied between environments.
8. **Backend env** has no leftover values from another environment (grep the
   env file for the other network's hostnames and passphrases).

### 0.3 Safe failure examples

These are the expected, safe outcomes when a combination is wrong. In every
case the system must **fail closed** — refuse to start or refuse the operation
— rather than silently proceeding.

- **Passphrase / endpoint mismatch.** Backend configured with the testnet
  passphrase but a mainnet RPC URL: startup validation rejects the config and
  the process exits non-zero. It does not fall back to a default network.
- **Cross-network contract ID.** A testnet contract ID supplied on mainnet:
  contract calls fail with a not-found / invalid-contract error; the indexer
  does not advance the cursor past the failed ledger.
- **Token from the wrong network.** A token ID that does not exist on the
  configured network: token reads fail explicitly; balances are not reported
  as zero.
- **Stale release artifact.** An artifact whose checksum does not match the
  published release for the target network: promotion is blocked before
  deploy.
- **Leaked cross-environment secret.** A deployer key from another environment:
  the deploy transaction is rejected by the network (wrong account / wrong
  network); the deploy job fails and does not retry with a different key.

If any of these occur, stop, correct the configuration, and re-run the
preflight checklist. Do not weaken network or chain validation to make a
deploy pass.

---

## 0.4 API version migration guides

This section publishes a migration guide for each supported API version. Each
guide links to the OpenAPI schema that defines the version's contract, lists
the explicit behavior differences from the previous version, gives the
deprecation timeline, and includes a compatibility checklist plus tested
request/response examples. Integrators should read the guide for the version
they are moving **to** before changing client code.

Supported versions and their schemas:

| API version | OpenAPI schema | Status | Deprecation date | Sunset date |
| --- | --- | --- | --- | --- |
| `v1` | [`openapi/v1.yaml`](../openapi/v1.yaml) | deprecated | 2025-06-30 | 2025-12-31 |
| `v2` | [`openapi/v2.yaml`](../openapi/v2.yaml) | current | — | — |

If a schema file is not present in your checkout, the version is not yet
published; do not integrate against an unpublished version.

### 0.4.1 Migrating `v1` → `v2`

**Schema:** [`openapi/v2.yaml`](../openapi/v2.yaml) (previous:
[`openapi/v1.yaml`](../openapi/v1.yaml)).

**Timeline.** `v1` is deprecated as of **2025-06-30** and will be sunset on
**2025-12-31**. After the sunset date, `v1` requests return `410 Gone`. During
the deprecation window both versions are served; `v1` responses include a
`Deprecation` header and a `Sunset` header carrying the dates above.

**Behavior differences.**

| Area | `v1` | `v2` |
| --- | --- | --- |
| Pagination | offset (`page`, `limit`) | cursor (`cursor`, `limit`); `next_cursor` in body |
| Timestamps | epoch seconds (integer) | RFC 3339 strings (UTC) |
| Amounts | decimal strings, unvalidated | decimal strings, validated against token decimals |
| Errors | `{ "error": "..." }` | `{ "error": { "code", "message", "details" } }` |
| Unknown query params | ignored | rejected with `400 invalid_request` |
| Missing resource | `200` with empty body | `404 not_found` |

**Compatibility checklist.**

- [ ] Client sends `Accept: application/vnd.api.v2+json` (or the `v2` path
      prefix) on every request.
- [ ] Pagination switched from `page`/`limit` to `cursor`/`limit`; client
      follows `next_cursor` until it is absent.
- [ ] Timestamp parsing handles RFC 3339 strings, not epoch integers.
- [ ] Error handling reads `error.code` / `error.message` instead of a flat
      string.
- [ ] Client tolerates `404` for missing resources (no longer `200` empty).
- [ ] Client stops sending query params the endpoint does not define.
- [ ] Amount handling validates against token decimals before display.
- [ ] Integration tests run against both `v1` and `v2` until `v1` sunset.

**Tested examples.**

`v1` request (deprecated):

```http
GET /api/v1/streams?page=1&limit=2 HTTP/1.1
Accept: application/vnd.api.v1+json
```

`v1` response (`200`):

```json
{
  "items": [
    { "id": "stream_1", "created_at": 1719792000, "amount": "10.5" }
  ],
  "page": 1,
  "limit": 2
}
```

`v2` request (current):

```http
GET /api/v2/streams?limit=2 HTTP/1.1
Accept: application/vnd.api.v2+json
```

`v2` response (`200`):

```json
{
  "items": [
    { "id": "stream_1", "created_at": "2024-07-01T00:00:00Z", "amount": "10.5" }
  ],
  "next_cursor": "c3RyZWFtXzE"
}
```

`v2` failure case — unknown query param (`400`):

```json
{ "error": { "code": "invalid_request", "message": "unknown query parameter: page" } }
```

`v2` boundary case — missing resource (`404`):

```json
{ "error": { "code": "not_found", "message": "stream not found" } }
```

These examples are exercised by the API contract tests; if a response shape
changes, update the schema, the tests, and this guide in the same PR.

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
migration-safe (create
