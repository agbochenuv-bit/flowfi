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

## Periodic Access Review for Operator Identities

Privileged **application** and **deployment** identities (admin wallets, CI/CD deploy keys, service accounts) are inventoried and reviewed on a fixed cadence so obsolete access is removed and every decision is auditable.

### Inventory

Each privileged identity is recorded with:

- **Identity**: stable identifier (wallet public key, service-account name, or deploy-key id)
- **Kind**: `application` or `deployment`
- **Scope**: the roles/permissions granted (e.g. `admin`, `deploy:production`)
- **Owner**: the team or person accountable for the identity
- **Created at**: when the identity was provisioned
- **Last used at**: last observed use (updated by the auth/audit path)

### Review Workflow

Reviews run on a periodic cadence (default every 90 days, configurable via `ACCESS_REVIEW_INTERVAL_DAYS`). For each identity the reviewer records:

- **Reviewer**: the authenticated operator performing the review
- **Timestamp**: when the review decision was made
- **Outcome**: one of `retain`, `revoke`, or `rotate`
- **Note**: optional justification

A review is **complete** only when every identity in the inventory has a recorded outcome for the current cycle. Identities without a current-cycle review are surfaced as pending.

### Stale Identity Detection

An identity is flagged **stale** when either condition holds:

- It has not been used within `ACCESS_REVIEW_STALE_DAYS` (default 90), or
- It has no recorded review outcome for the current review cycle.

Stale identities are reported for review; they are **not** auto-revoked. Removal of obsolete access is an explicit `revoke` outcome recorded by a reviewer, preserving the audit trail.

### Credential Handling

The access-review workflow **never** publishes or logs credential material. Inventory and review records contain only identity metadata (identifiers, scopes, owners, timestamps, outcomes). Secrets, private keys, tokens, and signed challenges are never stored in or emitted by review records, and review endpoints redact any credential-like fields before returning or logging.

### Externally Observable Behavior

| Condition | Status | `error` code |
| --- | --- | --- |
| Review submitted without reviewer identity | `401` | `MISSING_TOKEN` |
| Review outcome not in `retain`/`revoke`/`rotate` | `400` | `VALIDATION_ERROR` |
| Review references unknown identity | `404` | `IDENTITY_NOT_FOUND` |
| Non-admin operator attempts a review | `403` | `WALLET_SCOPE_FORBIDDEN` |

### Migration Notes (Access Reviews)

- Existing privileged identities must be seeded into the inventory before the first review cycle; unreviewed identities are reported as stale until reviewed.
- `ACCESS_REVIEW_INTERVAL_DAYS` and `ACCESS_REVIEW_STALE_DAYS` are additive configuration; defaults preserve prior behavior (no automatic revocation).

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

## Endpoint-Specific Wallet Authorization Scopes

Authenticated endpoints enforce ownership at the route/service boundary. The server derives the acting wallet from the verified JWT and **never trusts client-supplied sender or recipient addresses** for authorization decisions.

| Resource | Read | Mutate |
| --- | --- | --- |
| User profile (`/v1/users/:publicKey`) | Owner wallet only | Owner wallet only |
| Streams (`/v1/streams/:id`) | Sender or recipient wallet | Sender wallet only |
| Admin (`/v1/admin/*`) | Admin wallet (allowlisted) | Admin wallet (allowlisted) |
| Webhooks (`/v1/webhooks/:id`) | Owner wallet only | Owner wallet only |
| Public resources (e.g. `/v1/streams` list, health) | Anyone | N/A |

Violations return `403 WALLET_SCOPE_FORBIDDEN` without disclosing whether the target resource exists. Admin routes additionally require the acting wallet to be present in the configured admin allowlist; a valid JWT for a non-admin wallet is rejected.
