# API Hardening

This document describes the externally observable behavior, migration path, rollout strategy, and operational impact of four API hardening features:

1. Versioned error envelope and stable machine-readable error codes
2. Principal-aware rate limits for expensive operations
3. Stable cursor pagination for stream and event history
4. Idempotency keys for retryable stream commands

All four features are additive and preserve existing public interfaces unless explicitly noted. Where behavior changes, a versioned compatibility plan is provided.

---

## 1. Versioned Error Envelope and Stable Codes

### Externally Observable Behavior

All REST error responses now use a single documented envelope:

```json
{
  "error": {
    "code": "STREAM_NOT_FOUND",
    "message": "The requested stream does not exist.",
    "requestId": "req_01HZX8...",
    "details": [
      { "field": "streamId", "issue": "not_found" }
    ]
  }
}
```

- `code` — a stable, machine-readable identifier. Codes are part of the public contract and will not change meaning within a major API version. New codes may be added at any time; clients must treat unknown codes as a generic failure.
- `message` — a safe, human-readable description. Internal exception text, stack traces, database errors, and upstream provider messages are **never** included.
- `requestId` — a correlation ID that matches the `X-Request-Id` response header and server logs. Clients should log this value and include it in support requests.
- `details` — present for validation failures. A consistent array of `{ field, issue }` objects. Absent for non-validation errors.

### Stable Code Families

| Family | Example codes |
| --- | --- |
| Validation | `VALIDATION_FAILED`, `INVALID_CURSOR`, `IDEMPOTENCY_KEY_REUSED` |
| Authentication / authorization | `UNAUTHENTICATED`, `FORBIDDEN` |
| Not found | `STREAM_NOT_FOUND`, `EVENT_NOT_FOUND` |
| Rate limiting | `RATE_LIMITED` |
| Conflict | `CONFLICT`, `IDEMPOTENCY_IN_PROGRESS` |
| Internal | `INTERNAL_ERROR` |

`INTERNAL_ERROR` is the only code returned for unexpected server-side failures. The associated `message` is always a fixed, generic string.

### Migration and Rollout

- The envelope is introduced under the API version header. Clients that do not send a version header receive the legacy error shape during the deprecation window.
- The legacy shape is deprecated and will be removed at the next major version. Clients should migrate to reading `error.code` rather than parsing `message`.
- Validation error `details` replace the previous ad-hoc field error format; both are emitted during the transition window.

### Operational Impact

- Error responses are logged with the same `requestId`, enabling end-to-end correlation.
- Internal exception text is redacted at the serialization boundary; contract tests assert that no internal text leaks for representative errors across all route families.

---

## 2. Principal-Aware Rate Limits

### Externally Observable Behavior

Rate limits are applied per principal (authenticated account) where available, falling back to client IP for anonymous callers. Expensive operations have dedicated per-route budgets:

| Operation family | Scope | Budget (example) |
| --- | --- | --- |
| Account mutations | per account | 30 / minute |
| Exports | per account | 5 / minute |
| Analytics queries | per account | 60 / minute |
| Replay | per account | 10 / minute |
| Webhook management | per account | 20 / minute |
| Anonymous (any route) | per IP | 60 / minute |

When a limit is exceeded, the API returns HTTP `429` with the standard error envelope:

```json
{
  "error": {
    "code": "RATE_LIMITED",
    "message": "Too many requests. Please retry later.",
    "requestId": "req_01HZX8..."
  }
}
```

The response includes:

- `Retry-After` — seconds until the caller may retry.
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` — standard informational headers.

### Proxy Trust Behavior

Forwarding headers (`X-Forwarded-For`, `Forwarded`) are honored **only** when the request originates from a configured trusted proxy. Untrusted callers cannot influence their rate-limit identity by spoofing these headers; such requests are attributed to the connecting peer address.

### Safe Fallback

If the rate-limit store (Redis) is unavailable, the API fails **open** for read operations and applies a conservative in-process fallback budget for expensive write operations, so that a store outage does not cause a full denial of service. Fallback activation is logged and surfaced via operational metrics.

### Migration and Rollout

- IP-only limits remain in effect for anonymous callers; authenticated callers gain principal-scoped budgets. No client change is required.
- Budgets are configurable per deployment and may be tuned without a version bump.

### Operational Impact

- Counters are shared across instances via Redis, so limits are enforced globally rather than per instance.
- Spoofed forwarding headers from untrusted sources are ignored and counted against the peer address.
- Redis outages trigger the documented fallback; dashboards alert on fallback activation.

---

## 3. Stable Cursor Pagination

### Externally Observable Behavior

High-volume stream and event history endpoints support opaque cursor pagination:

```
GET /streams?limit=50&cursor=<opaque>
```

Responses include:

```json
{
  "items": [ ... ],
  "nextCursor": "<opaque>",
  "hasMore": true
}
```

- `cursor` is opaque and must be passed back verbatim. Clients must not parse or construct cursors.
- `limit` is bounded; out-of-range values are clamped or rejected with `VALIDATION_FAILED`.

### Ordering Guarantees

- Results are ordered deterministically by `(createdAt, id)` — timestamp first, then a unique tiebreaker — so that rows with equal timestamps are never reordered between pages.
- Across page boundaries, no row is skipped or duplicated, including under concurrent inserts. Newly inserted rows that sort after the cursor position appear on subsequent pages; rows inserted before the cursor position are not retroactively included.

### Cursor Expiry

- Cursors encode their ordering position and are valid for a bounded window (default 24 hours). Expired or malformed cursors return `INVALID_CURSOR` with a message instructing the client to restart pagination from the first page.
- Cursors are not tied to a session and may be reused across requests within their validity window.

### Migration and Rollout

- Cursor pagination is introduced under the API version header. Legacy offset-based pagination remains available during the deprecation window and returns the existing response shape.
- Clients opt in by sending the version header; the response shape for legacy callers is unchanged.

### Operational Impact

- Cursor queries use indexed `(createdAt, id)` scans, avoiding deep-offset performance degradation.
- Cursor encoding is versioned internally so that the format can evolve without breaking outstanding cursors within their validity window.

---

## 4. Idempotency Keys for Retryable Stream Commands

### Externally Observable Behavior

Commands that submit on-chain transactions accept an `Idempotency-Key` header:

```
POST /streams/{id}/commands
Idempotency-Key: 8f14e45f-ceea-467a-...
```

- A key is bound to the authenticated wallet, the operation type, and a hash of the request body.
- Retrying with the **same key and identical input** returns the original result (same status and body), without submitting a second transaction.
- Reusing a key with **changed input** is rejected with `IDEMPOTENCY_KEY_REUSED` (HTTP `409`).
- A retry that arrives while the original is still in flight returns `IDEMPOTENCY_IN_PROGRESS` (HTTP `409`) with a `Retry-After` hint.

### Retention

- Idempotency records are retained for a bounded window (default 24 hours) after the original request completes. After expiry, the key may be reused as a new request.
- Retention is durable across instances and restarts.

### Conflict Semantics

| Situation | Result |
| --- | --- |
| Same key, same input, original completed | Original result replayed |
| Same key, same input, original in flight | `409 IDEMPOTENCY_IN_PROGRESS` |
| Same key, different input | `409 IDEMPOTENCY_KEY_REUSED` |
| Same key, different wallet or operation | Treated as a distinct key scope; no conflict |
| No key supplied | Request processed normally (no idempotency guarantee) |

Concurrent duplicate submissions with the same key trigger **at most one** transaction.

### Migration and Rollout

- The header is optional. Clients that omit it retain existing behavior with no idempotency guarantee.
- Clients are encouraged to adopt idempotency keys for all transaction-submitting commands to make retries safe.

### Operational Impact

- Idempotency records are stored durably and shared across instances, so retries routed to any instance observe the same result.
- Record storage is bounded by the retention window; expired records are reclaimed automatically.
- Metrics track replay hits, in-progress conflicts, and key-reuse rejections for operational visibility.

---

## Cross-Cutting Notes

- All four features emit the standard error envelope and correlation `requestId`, so failures are traceable end to end.
- Contract, regression, and boundary tests live at each owning component's existing test layer and assert the behaviors documented above, including that internal exception text is never exposed.
- No existing public interface is removed by these changes; versioned compatibility windows govern every behavior change.