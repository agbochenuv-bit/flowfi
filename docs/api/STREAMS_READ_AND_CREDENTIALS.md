# Stream Reads, Search, Chain Freshness, and Wallet-Scoped API Credentials

This document specifies the API contracts, operational bounds, failure and recovery
states, and security boundaries for:

- **#229** — Bounded multi-stream read endpoint (`POST /v1/streams/batch-read`)
- **#230** — Normalized stream search and filter semantics (`GET /v1/streams`)
- **#231** — Explicit chain freshness and finality metadata (`GET /v1/streams/freshness`, read payloads, `X-Chain-*` headers, and `GET /health`)
- **#232** — Wallet-scoped API credentials for integrations (`/v1/credentials`)

All changes are additive and backward-compatible with existing `/v1` consumers.

---

## 1. Bounded Multi-Stream Read (`POST /v1/streams/batch-read`) [#229]

Fetches multiple streams in a single bounded database query while preserving the
caller's deduplicated request order and surfacing explicit per-item outcomes.

### Authoritative Bounds

| Limit | Value | Error on Violation |
| --- | --- | --- |
| Minimum `streamIds` | `1` | `400 EMPTY_BATCH_REQUEST` |
| Maximum `streamIds` | `50` (`MAX_BATCH_READ_STREAM_IDS`) | `400 BATCH_LIMIT_EXCEEDED` |
| Maximum optional RPC fallbacks per request | `5` (`MAX_BATCH_RPC_FALLBACKS`) | Capped; `meta.rpcFallbackCapped = true` |

### Request Body

```json
{
  "streamIds": ["101", "102", "999"],
  "includeClaimable": true,
  "allowRpcFallback": false,
  "at": 1732400000,
  "network": "testnet"
}
```

### Response (`200 OK`)

```json
{
  "items": [
    {
      "streamId": "101",
      "status": "found",
      "source": "indexer",
      "stream": { "streamId": "101", "sender": "G...", "recipient": "G..." },
      "claimable": { "streamId": 101, "claimableAmount": "500", "actionable": true }
    },
    {
      "streamId": "999",
      "status": "not_found",
      "source": null,
      "stream": null
    }
  ],
  "streams": [{ "streamId": "101", "sender": "G...", "recipient": "G..." }],
  "missingStreamIds": ["999"],
  "failedStreamIds": [],
  "meta": {
    "requestedCount": 3,
    "uniqueCount": 3,
    "duplicateCount": 0,
    "foundCount": 1,
    "missingCount": 1,
    "failedCount": 0,
    "maxBatchSize": 50,
    "rpcFallbacksUsed": 0,
    "rpcFallbackCap": 5,
    "rpcFallbackCapped": false,
    "partial": true,
    "recoveryHint": "Some requested streamIds were not found in the indexer. If recently created on-chain, retry after ledger ingestion or enable allowRpcFallback."
  },
  "freshness": { "...": "ChainFreshness" }
}
```

### Failure & Recovery Semantics

- **Malformed inputs / over-limit batches (`400`)**: Rejected before querying the database, with `error.details.recoveryHint` telling callers how to chunk or fix inputs.
- **Network mismatch (`409 NETWORK_MISMATCH`)**: Rejected when `network` does not match the configured indexer network.
- **Per-item isolation (`200` with `meta.partial = true`)**: A failure during optional claimable calculation or RPC fallback marks only that item `status: "error"` with `retryable: true | false` and appends it to `failedStreamIds`.
- **Primary database outage (`503 BATCH_READ_UNAVAILABLE`)**: Returns `error.details.retryable = true` with exponential-backoff recovery guidance.

---

## 2. Normalized Stream Search & Filter Semantics (`GET /v1/streams`) [#230]

`GET /v1/streams` enforces deterministic normalization and strict validation at the
API boundary and echoes canonical evaluation state in `appliedFilters`.

### Supported Query Parameters

| Parameter | Alias | Normalization & Semantics |
| --- | --- | --- |
| `q` | `search` | Trimmed, internal whitespace collapsed, max 128 chars. Numeric strings match exact `streamId` OR case-insensitive substring on `sender`/`recipient`/`tokenAddress`. |
| `sender` | — | Trimmed; Stellar `G...`/`C...` StrKeys canonicalized to uppercase. |
| `recipient` | — | Trimmed; Stellar `G...`/`C...` StrKeys canonicalized to uppercase. |
| `participant` | `address` | Matches `sender = value OR recipient = value`. Conflicting `participant` and `address` return `400 CONFLICTING_FILTERS`. |
| `token` | `tokenAddress` | Canonicalized identifier. Conflicting `token` and `tokenAddress` return `400 CONFLICTING_FILTERS`. |
| `status` | — | Single, comma-separated (`active,paused`), or repeated query params; case-insensitive, deduplicated, sorted canonically. Allowed: `active`, `paused`, `cancelled`, `completed`. |
| `startTimeFrom` / `startTimeTo` | `startAfter` / `startBefore` | Non-negative Unix timestamps (seconds). Inverted bounds return `400 INVALID_RANGE`. |
| `endTimeFrom` / `endTimeTo` | — | Non-negative Unix timestamps (seconds). Inverted bounds return `400 INVALID_RANGE`. |
| `createdAfter` / `createdBefore` | — | ISO-8601 date or Unix seconds. Inverted bounds return `400 INVALID_RANGE`. |
| `sort` | `sortBy` | Allowed: `createdAt`, `startTime`, `lastUpdateTime`, `depositedAmount`, `endTime`, `streamId` (snake_case aliases normalized). Unknown values return `400 INVALID_SORT_FIELD`. |
| `order` | `sortOrder` | `asc` or `desc` (case-insensitive, default `desc`). |
| `limit` | `pageSize` | Integer `1..100` (default `20`). Out-of-range returns `400 INVALID_PAGINATION`. |
| `offset` / `page` | — | Non-negative offset or 1-based page. Combining `cursor` with non-zero `offset` / `page > 1` returns `400 CONFLICTING_PAGINATION`. |
| `network` | — | Must match the indexer's configured network or returns `409 NETWORK_MISMATCH`. |

---

## 3. Chain Freshness & Finality Metadata [#231]

Explicit freshness and finality metadata is exposed on:
- `GET /v1/streams/freshness` (dedicated operator & client freshness endpoint; includes live network tip by default)
- `GET /v1/streams`, `POST /v1/streams/batch-read`, `GET /v1/streams/:streamId`, `GET /v1/streams/:streamId/events`, and `GET /v1/streams/:streamId/claimable` (additive `freshness` object + `X-Chain-*` headers)
- `GET /health` (additive `chainFreshness` summary)

### Classification States

| `freshness` | `stale` | `finality` | Meaning & Recovery |
| --- | --- | --- | --- |
| `fresh` | `false` | `finalized` | Indexed snapshot is within thresholds and corroborated by a non-reverted `LedgerCheckpoint` (or read live from Soroban RPC). |
| `fresh` | `false` | `indexed_unverified` | Indexed snapshot is current, but no verified `LedgerCheckpoint` covers this ledger yet. Confirm via RPC for settlement-critical flows. |
| `stale` | `true` | `stale` | Indexer age exceeds `CHAIN_FRESHNESS_STALE_SECONDS` (default `30s`) or ledger lag exceeds `CHAIN_MAX_LEDGER_LAG` (default `6`). Wait for catch-up or query RPC directly. |
| `unknown` | `true` | `unknown` | Cold start / no indexed checkpoint exists yet (`INDEXER_STATE_UNAVAILABLE`). |
| `degraded` | `true` | `unknown` | Freshness/checkpoint/RPC probes failed; `degradedReason` and `recoveryHint` explain remediation. |

### Response Headers

- `X-Chain-Network` (`testnet` | `mainnet`)
- `X-Chain-Data-Source` (`indexer` | `chain` | `hybrid` | `unknown`)
- `X-Chain-Freshness` (`fresh` | `stale` | `degraded` | `unknown`)
- `X-Chain-Finality` (`finalized` | `indexed_unverified` | `pending` | `stale` | `unknown`)
- `X-Chain-Indexed-Ledger`, `X-Chain-Verified-Checkpoint-Ledger`, `X-Chain-Network-Ledger`, `X-Chain-Ledger-Lag` (emitted when known)

### Operator Configuration

- `CHAIN_FRESHNESS_STALE_SECONDS` (default `30`)
- `CHAIN_MAX_LEDGER_LAG` (default `6`)
- `CHAIN_FINALITY_CONFIRMATION_LEDGERS` (default `1`)

---

## 4. Wallet-Scoped API Credentials (`/v1/credentials`) [#232]

Enables backend workers and partner integrations to authenticate API requests on
behalf of a single wallet with least-privilege scopes, bounded TTLs, zero-downtime
rotation, and full auditability.

### Security Boundaries

1. **One-time secret display**: Secrets (`ffk_<live|test>_<8-hex-prefix>_<256-bit-random>`) are returned **only once** in `POST /v1/credentials` and `POST /v1/credentials/:id/rotate` with `Cache-Control: no-store`. Only a per-credential salted SHA-256 digest is stored; plaintext secrets are never persisted, returned on `GET`, or logged.
2. **Wallet-session management boundary**: All `/v1/credentials` endpoints and `/v1/admin/*` endpoints strictly require a wallet-signed JWT session (`POST /v1/auth/verify`). Presenting an API credential to manage credentials or admin routes fails with `403 WALLET_SESSION_REQUIRED`.
3. **No on-chain signing authority**: API credentials never replace Stellar wallet signatures or Soroban contract authorization.
4. **Cross-wallet isolation**: All credential inventory, detail, rotation, revocation, and audit operations are strictly scoped to the authenticated wallet. Accessing another wallet's credential ID returns `404 CREDENTIAL_NOT_FOUND`.
5. **Network isolation**: Credentials created on `testnet` cannot authenticate against `mainnet` (`401 CREDENTIAL_NETWORK_MISMATCH`).

### Allowed Scopes

Wildcard scopes (`*`) and admin scopes are forbidden. Every credential must declare
at least one scope from:

- `streams:read`
- `streams:write`
- `events:read`
- `webhooks:read`
- `webhooks:write`
- `exports:read`
- `exports:write`

### Presenting an API Credential

Callers may present the secret via any of:
- `X-API-Key: <secret>`
- `Authorization: ApiKey <secret>`
- `Authorization: Bearer <secret>` (recognized by the `ffk_` prefix)

### Lifecycle Endpoints (Wallet JWT Session Required)

| Method & Path | Description |
| --- | --- |
| `POST /v1/credentials` | Create credential (`name`, `scopes`, optional `expiresInSeconds` in `60..31536000`, default 30 days; max 25 active per wallet). Returns one-time `secret`. |
| `GET /v1/credentials` | List non-secret metadata for the authenticated wallet's credentials. |
| `GET /v1/credentials/:id` | Fetch non-secret metadata for a single owned credential (`404` for cross-wallet). |
| `POST /v1/credentials/:id/rotate` | Rotate an active credential. `gracePeriodSeconds` (`0..604800`, default `0`) controls immediate revocation vs bounded dual-key overlap. Returns new one-time `secret`. |
| `DELETE /v1/credentials/:id` | Immediately revoke a credential (and end any active grace window). Idempotent on retry. |
| `GET /v1/credentials/:id/audit` | Inspect sanitized lifecycle and authentication audit events (`credential.created`, `credential.rotated`, `credential.revoked`, `credential.auth_succeeded`, `credential.auth_failed`). |

### Verification Failure Codes & Recovery

| HTTP | Code | Recovery |
| --- | --- | --- |
| `401` | `CREDENTIAL_INVALID` | Verify the secret or issue a new credential. |
| `401` | `CREDENTIAL_REVOKED` | Switch to the replacement credential or create a new one. |
| `401` | `CREDENTIAL_EXPIRED` | Create a new credential via `POST /v1/credentials`. |
| `401` | `CREDENTIAL_ROTATED_EXPIRED` | Deploy the replacement secret returned by `POST /v1/credentials/:id/rotate`. |
| `401` | `CREDENTIAL_NETWORK_MISMATCH` | Issue a credential on the target Stellar network. |
| `403` | `INSUFFICIENT_SCOPE` | Create or rotate a credential granting the missing scopes listed in `error.details.missingScopes`. |
| `403` | `WALLET_SESSION_REQUIRED` | Authenticate with a wallet-signed JWT session instead of an API credential. |
