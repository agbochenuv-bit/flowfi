---
title: Webhooks
---

# Webhooks

Outbound webhook deliveries notify integrators when their wallet is touched
by an indexed event.

## Delivery contract

- `POST` to the subscriber's URL with an HMAC signature header
  (`X-FlowFi-Signature`) over the raw body.
- Retries use **exponential backoff** on non-2xx responses and timeouts:
  30s → 1m → 5m → 30m → 2h (six attempts), then dead-letter.

```mermaid
sequenceDiagram
    participant W as Webhook worker
    participant S as Subscriber
    participant D as Dead-letter table

    W->>S: POST event (signed)
    S-->>W: 500
    Note over W: retry in 1m
    W->>S: POST event (signed)
    S-->>W: 500
    Note over W: retry in 5m … then 30m, 2h
    W->>D: mark dead-letter after final attempt
    Note over D: operator triage via /admin
```

## Canonical serialization

The signature is computed over the **raw request body bytes exactly as sent**.
To make the signed bytes reproducible, the body is serialized as canonical
JSON:

- Object keys are sorted lexicographically (by Unicode code point) at every
  nesting level.
- No insignificant whitespace (no spaces, newlines, or tabs between tokens).
- Strings use standard JSON escaping; numbers use the shortest round-trippable
  representation; `null` is preserved.
- Arrays keep their original order.

Integrators should verify against the raw bytes they received, **not** against a
re-serialization of the parsed JSON. If you must re-serialize (e.g. to compare
against a stored copy), apply the same canonicalization rules above.

## Signature header format

Every delivery carries a single `X-FlowFi-Signature` header with a
comma-separated list of key/value pairs:

```
X-FlowFi-Signature: t=1700000000,v1=<hex-hmac>,kid=<key-id>
```

| Field | Meaning |
| ----- | ------- |
| `t`   | Unix timestamp (seconds) when the signature was produced. |
| `v1`  | Lowercase hex HMAC-SHA256 over `"<t>.<raw_body>"` using the subscriber secret identified by `kid`. |
| `kid` | Identifier of the signing key. Lets you select the right secret during rotation. |

The signed message is the ASCII timestamp, a literal `.`, then the raw body
bytes:

```
signed_payload = ascii(t) + "." + raw_body
v1 = hex(HMAC_SHA256(secret_for(kid), signed_payload))
```

### Verifying signatures

```python
import hmac, hashlib, time

TOLERANCE_SECONDS = 300  # 5 minutes

def parse_header(header: str) -> dict:
    parts = {}
    for pair in header.split(","):
        key, _, value = pair.strip().partition("=")
        parts[key] = value
    return parts

def verify(secret_for_kid, raw_body: bytes, header: str, now: int | None = None) -> bool:
    parts = parse_header(header)
    t = parts.get("t")
    v1 = parts.get("v1")
    kid = parts.get("kid")
    if not (t and v1 and kid):
        return False

    now = int(time.time()) if now is None else now
    if abs(now - int(t)) > TOLERANCE_SECONDS:
        return False  # expired / clock skew beyond tolerance

    secret = secret_for_kid(kid)
    if secret is None:
        return False  # unknown key id

    signed = f"{t}.".encode() + raw_body
    expected = hmac.new(secret.encode(), signed, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)
```

## Endpoint lifecycle

Webhook endpoints are owned by the account that created them. Every
lifecycle operation is authorized against that ownership: a caller may only
create, update, disable, or delete endpoints belonging to their own account.
Requests against endpoints owned by another account are rejected as
not-found (they do not leak existence).

### Create

- `POST /webhooks` registers a new endpoint.
- The request is validated before persistence: the URL must be an absolute
  `https` URL, and the secret must be present and meet the minimum length.
  Invalid input is rejected with a validation error and nothing is stored.
- New endpoints are created in the **enabled** state and begin receiving
  deliveries immediately.

### Update

- `PATCH /webhooks/{id}` updates the URL and/or rotates the secret.
- The same validation rules as create apply. An update that fails validation
  leaves the stored endpoint unchanged.
- Rotating the secret takes effect for subsequent deliveries; in-flight
  retries for already-signed attempts are not re-signed.

### Disable

- `POST /webhooks/{id}/disable` transitions the endpoint to the **disabled**
  state.
- While disabled, the endpoint receives **no new deliveries**. Events that
  occur during the disabled window are not queued for the endpoint; they are
  not delivered retroactively when it is re-enabled.
- Disabling is idempotent: disabling an already-disabled endpoint succeeds
  without error.

### Delete

- `DELETE /webhooks/{id}` removes the endpoint.
- Deletion is idempotent from the caller's perspective: deleting an
  already-deleted endpoint returns success.
- After deletion the endpoint receives no further deliveries. Its delivery
  history remains available for audit until retention expires.

## Replay of failed deliveries

Replay re-sends previously **failed** deliveries for a single endpoint. It is
scoped and bounded by design:

- **Failed-only.** Only deliveries that ended in a failed terminal state
  (dead-lettered after exhausting retries) are eligible. Successful
  deliveries are never re-sent by replay.
- **Bounded window.** Replay accepts an explicit time window. Deliveries
  outside the window are ignored, and the number of deliveries replayed per
  request is capped. Requests exceeding the cap are rejected rather than
  silently truncated.
- **Scoped.** Replay targets exactly one endpoint owned by the caller;
  ownership checks apply as for the other lifecycle operations.
- **Rate limited.** Replay requests are subject to a per-account rate limit.
  Requests over the limit are rejected with a rate-limit error and no
  deliveries are re-sent.
- **Audit history.** Each replay request records an audit entry capturing the
  requesting account, the target endpoint, the window, and the set of
  deliveries replayed. Replayed deliveries are marked as replays in the
  delivery history so operators can distinguish them from original attempts.

## Rollout and migration notes

- New schema fields back the lifecycle and replay features: an endpoint
  `state` (enabled/disabled) and delivery records that track terminal failure
  and replay provenance.
- Existing endpoints migrate to the **enabled** state, preserving current
  delivery behavior.
- Existing delivery records are treated as non-replayable unless they are in
  a failed terminal state; successful historical deliveries are never
  eligible for replay.
- The public delivery contract (signature header, backoff schedule) is
  unchanged; lifecycle and replay are additive and do not alter existing
  endpoints' behavior until an operator uses them.
