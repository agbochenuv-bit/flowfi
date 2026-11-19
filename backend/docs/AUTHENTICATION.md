# Authentication Middleware (SEP-10 + JWT)

FlowFi API uses the Stellar SEP-10 challenge flow to authenticate wallets, then issues a JWT for subsequent API requests.

## Overview

Authentication is performed in two phases:

1. Client requests a challenge from `/v1/auth/challenge`
2. Client signs the challenge transaction and submits it to `/v1/auth/verify`
3. Server verifies the nonce and returns a JWT
4. Client uses `Authorization: Bearer <JWT>` for authenticated endpoints

This simplifies clients and standardizes authentication across all protected routes.

## Using the Middleware

### Protected Routes

Apply `requireAuth` to any route that requires authentication:

```typescript
import { requireAuth } from '../middleware/auth.js';
import { Router } from 'express';

const router = Router();

// Protected endpoint
router.get('/me', requireAuth, getCurrentUser);
```

### Optional Authentication

Use `optionalAuthMiddleware` for routes where authentication is optional:

```typescript
import { optionalAuthMiddleware } from '../middleware/auth.middleware.js';

router.get('/streams', optionalAuthMiddleware, getStreams);
```

## Request Format

### Authorization Header

```
Authorization: Bearer <jwt>
```

### Example

```bash
curl -X GET http://localhost:3001/v1/users/me \
  -H "Authorization: Bearer AAAAAgAAAAC..."
```

## Transaction Requirements

The signed transaction must meet these requirements:

1. **Source Account**: Must be the user's Stellar public key
2. **Valid Signature**: Signature must be valid for the source account
3. **Time Bounds** (optional but recommended): Transaction should include time bounds to prevent replay attacks
4. **Network**: Must match the configured Stellar network (testnet or mainnet)

## Wallet Challenges (Single-Use, Replay-Resistant)

Challenges issued by `/v1/auth/challenge` are **single-use** and bound to a specific context. Each challenge is persisted server-side and records:

- **Wallet**: the Stellar public key the challenge was issued for
- **Audience**: the intended relying party (configured via `AUTH_AUDIENCE`)
- **Network**: the Stellar network passphrase active when the challenge was issued
- **Expiration**: an absolute expiry timestamp (`AUTH_CHALLENGE_TTL_SECONDS`, default 300s)

`/v1/auth/verify` accepts a challenge exactly once. A successful exchange consumes the nonce; any subsequent submission of the same signed challenge is rejected. Verification fails if the signing wallet, audience, network, or expiry does not match the stored challenge.

### Externally Observable Behavior

| Condition | Status | `error` code |
| --- | --- | --- |
| Challenge reused after successful exchange | `401` | `CHALLENGE_ALREADY_USED` |
| Challenge expired | `401` | `CHALLENGE_EXPIRED` |
| Challenge signed by a different wallet | `401` | `CHALLENGE_WALLET_MISMATCH` |
| Challenge audience mismatch | `401` | `CHALLENGE_AUDIENCE_MISMATCH` |
| Challenge network mismatch | `401` | `CHALLENGE_NETWORK_MISMATCH` |
| Unknown / never-issued challenge | `401` | `CHALLENGE_NOT_FOUND` |
| Malformed challenge request body | `400` | `VALIDATION_ERROR` |

### Migration Notes (Challenges)

- Clients that previously reused a signed challenge (or cached a nonce across requests) **must** request a fresh challenge for every login. Reuse now returns `401 CHALLENGE_ALREADY_USED`.
- Clients must send the same `network` and `audience` they used when requesting the challenge; mismatches are rejected.
- If `AUTH_CHALLENGE_TTL_SECONDS` is lowered, clients should request and submit challenges promptly rather than pre-generating them.

## Secret Resolution (External Secret Manager)

Signing keys and database credentials can be sourced from an external secret manager instead of long-lived plaintext environment variables. Environment variables remain supported as a fallback, so existing deployments keep working without changes.

### Configuration

| Variable | Purpose |
| --- | --- |
| `SECRET_MANAGER_PROVIDER` | Provider to use (`env` default, or an external provider name). When unset, secrets resolve from environment variables only. |
| `SECRET_MANAGER_REFRESH_SECONDS` | Interval for periodic re-fetch of managed secrets (default `300`). Set to `0` to disable periodic refresh. |
| `SECRET_MANAGER_REQUIRED` | When `true`, startup fails if the provider cannot resolve required secrets. When `false`, startup proceeds in degraded mode using cached/env values. |

### Startup Semantics

- On boot the resolver fetches all required secrets (signing key, database credentials) from the configured provider.
- If `SECRET_MANAGER_REQUIRED=true` and the provider is unavailable or a required key is missing, startup **fails fast** with a redacted error naming only the missing key path.
- If `SECRET_MANAGER_REQUIRED=false`, startup proceeds in **degraded mode**: it falls back to environment values and logs a redacted warning. Requests that require an unresolved secret fail with `503 SECRET_UNAVAILABLE`.

### Refresh / Rotation

- Managed secrets are re-fetched every `SECRET_MANAGER_REFRESH_SECONDS` and swapped **atomically**; in-flight requests continue using the previous value until the swap completes.
- A rotated value is picked up on the next refresh cycle without a restart. Rotation never logs the secret material — only the key path and a version/etag when the provider supplies one.

### Failure Semantics (Provider Unavailable)

- **At startup**: governed by `SECRET_MANAGER_REQUIRED` (fail-fast vs. degraded, see above).
- **Mid-run outage**: the last successfully resolved value is retained (cached) and continues to be used. Refresh retries with exponential backoff and surfaces a redacted error (`SECRET_REFRESH_FAILED`) in logs and health output.
- **Missing key**: resolution fails for that key only; the error names the key path, never the value.
- **Malformed provider response**: treated as a resolution failure (same handling as unavailable provider); the raw response is never logged.

### Redaction Guarantees

Resolved secret values are never written to logs, error messages, health endpoints, or test output. Errors reference key paths and provider status only. Tests assert on redacted output to prevent accidental leakage.

## Error Responses

All errors share a predictable envelope produced by centralized validation and error mapping:

```json
{
  "error": "Unauthorized",
  "code": "CHALLENGE_EXPIRED",
  "message": "Challenge has expired",
  "requestId": "b1f2c3d4-..."
}
```

- `error` is a stable, human-readable category.
- `code` is a stable machine-readable identifier (safe to branch on).
- `message` is a safe description; it never includes stack traces, SQL, or internal identifiers.
- `requestId` correlates the response with server logs.

### 400 Bad Request - Validation Error

Returned when a request body, path parameter, or query parameter fails schema validation. The response lists field-level issues without echoing sensitive values.

```json
{
  "error": "Bad Request",
  "code": "VALIDATION_ERROR",
  "message": "Invalid request payload",
  "details": [
    { "path": "publicKey", "message": "Invalid Stellar public key" }
  ],
  "requestId": "b1f2c3d4-..."
}
```

### 401 Unauthorized - Missing Token

```json
{
  "error": "Unauthorized",
  "code": "MISSING_TOKEN",
  "message": "Missing or invalid Authorization header. Expected format: Bearer <jwt>",
  "requestId": "b1f2c3d4-..."
}
```

### 401 Unauthorized - Invalid Signature

```json
{
  "error": "Unauthorized",
  "code": "INVALID_SIGNATURE",
  "message": "Invalid or expired signature",
  "requestId": "b1f2c3d4-..."
}
```

### 403 Forbidden - Wallet Scope Violation

Returned when an authenticated wallet attempts to read or mutate a resource it does not own. The response does not reveal whether the resource exists.

```json
{
  "error": "Forbidden",
  "code": "WALLET_SCOPE_FORBIDDEN",
  "message": "Authenticated wallet is not authorized for this resource",
  "requestId": "b1f2c3d4-..."
}
```

### 500 Internal Server Error

Unexpected failures return a generic message with no stack trace or internal identifiers.

```json
{
  "error": "Internal Server Error",
  "code": "INTERNAL_ERROR",
  "message": "An unexpected error occurred",
  "requestId": "b1f2c3d4-..."
}
```

### 503 Service Unavailable - Secret Unavailable

Returned when a required secret could not be resolved (degraded startup or mid-run outage with no cached value). The message names the key path only, never the value.

```json
{
  "error": "Service Unavailable",
  "code": "SECRET_UNAVAILABLE",
  "message": "Required secret is unavailable",
  "requestId": "b1f2c3d4-..."
}
```

### Migration Notes (Errors)

- Clients that parsed only `message` should migrate to branching on `code`, which is stable across releases.
- New `details` arrays appear only on `400 VALIDATION_ERROR` responses.
- `requestId` is additive; clients may log it for support escalation.

## Security Features

1. **Signature Verification**: Cryptographically verifies the transaction was signed by the claimed public key
2. **Single-Use Challenges**: Each challenge is consumed on first successful verification; replays are rejected
3. **Challenge Binding**: Challenges are bound to wallet, audience, network, and expiry
4. **Time Bounds**: Supports transaction time bounds to prevent replay attacks
5. **Network Validation**: Ensures transactions match the configured Stellar network
6. **No Password Storage**: No sensitive credentials stored on the server
7. **External Secret Resolution**: Signing and database secrets can be sourced from a secret manager with atomic rotation and redacted errors

## Endpoint-Specific Wallet Authorization Scopes

Authenticated endpoints enforce ownership at the route/service boundary. The server derives the acting wallet from the verified JWT and **never trusts client-supplied sender or recipient addresses** for authorization decisions.

| Resource | Read | Mutate |
| --- | --- | --- |
| User profile (`/v1/users/:publicKey`) | Owner wallet only | Owner wallet only |
| Streams (`/v1/streams/:id`) | Sender or recipient wallet | Sender wallet only |
| Admin (`/v1/admin/*`) | Admin wallet (allowlisted) | Admin wallet (allowlisted) |
| Webhooks (`/v1/webhooks/:id`) | Owner wallet only | Owner wallet only |
| Public resources (e.g. `/v1/streams` list, health) | Anyone | N/A |

Violations return `403 WALLET_SCOPE_FORBIDDEN` without disclosing resource existence.
