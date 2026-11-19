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

## Signed Action Permits (Scoped, Expiring, Revocable)

Wallet and delegated action flows (e.g. delegated stream mutations) are authorized by **signed action permits**. A permit is a signed artifact that grants a specific wallet the right to perform a specific action against a specific contract on a specific network, until it expires or is revoked.

Each permit binds the following fields, all of which are verified before the action executes:

- **Wallet**: the acting Stellar public key the permit was issued to
- **Network**: the Stellar network passphrase the permit is valid on
- **Contract**: the target contract/account the action applies to
- **Scope**: the specific action(s) the permit authorizes (e.g. `stream:withdraw`)
- **Expiration**: an absolute expiry timestamp
- **Nonce**: a unique identifier used to detect replay

Permits are **single-use**: a successful action consumes the permit's nonce, and any subsequent submission of the same permit is rejected as a replay. Permits may also be **revoked** before expiry; a revoked permit is rejected even if it is otherwise valid and unexpired.

### Externally Observable Behavior

| Condition | Status | `error` code |
| --- | --- | --- |
| Permit reused after a successful action | `401` | `PERMIT_ALREADY_USED` |
| Permit expired | `401` | `PERMIT_EXPIRED` |
| Permit network does not match the active network | `401` | `PERMIT_NETWORK_MISMATCH` |
| Permit contract does not match the target contract | `401` | `PERMIT_CONTRACT_MISMATCH` |
| Permit scope does not cover the requested action | `403` | `PERMIT_SCOPE_MISMATCH` |
| Permit revoked | `401` | `PERMIT_REVOKED` |
| Permit signature invalid or wallet mismatch | `401` | `PERMIT_INVALID_SIGNATURE` |
| Unknown / never-issued permit | `401` | `PERMIT_NOT_FOUND` |

### Boundary Semantics

- Expiry is evaluated against the server clock at the moment the action is processed. A permit is valid strictly before its expiry timestamp and rejected at or after it.
- Replay detection is keyed on the permit nonce and is recorded only after the action succeeds; a failed action does not consume the permit.
- Revocation is checked on every use and takes effect immediately, regardless of remaining lifetime.

### Migration Notes (Permits)

- Clients must request a fresh permit for each action; permits cannot be reused across actions.
- Clients must target the same network and contract the permit was issued for; mismatches are rejected.
- Clients should handle `PERMIT_EXPIRED` and `PERMIT_REVOKED` by requesting a new permit rather than retrying the same one.

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
4. **Single-Use Permits**: Signed action permits are consumed on first successful use; replays are rejected
5. **Permit Binding**: Permits are bound to wallet, network, contract, scope, expiry, and revocation state
6. **Time Bounds**: Supports transaction time bounds to prevent replay attacks
7. **Network Validation**: Ensures transactions match the configured Stellar network
8. **No Password Storage**: No sensitive credentials stored on the server

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
