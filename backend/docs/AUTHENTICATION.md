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
======>>> REPLACE

<<<<<<< SEARCH
## Error Responses

### 401 Unauthorized - Missing Token

```json
{
  "error": "Unauthorized",
  "message": "Missing or invalid Authorization header. Expected format: Bearer <signed_transaction>"
}
```

### 401 Unauthorized - Invalid Signature

```json
{
  "error": "Unauthorized",
  "message": "Invalid or expired signature"
}
```
=======
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
======>>> REPLACE

<<<<<<< SEARCH
## Security Features

1. **Signature Verification**: Cryptographically verifies the transaction was signed by the claimed public key
2. **Time Bounds**: Supports transaction time bounds to prevent replay attacks
3. **Network Validation**: Ensures transactions match the configured Stellar network
4. **No Password Storage**: No sensitive credentials stored on the server
=======
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

Violations return `403 WALLET_SCOPE_FORBIDDEN`. Cross-wallet enumeration attempts (e.g. listing another wallet's streams by spoofing a query parameter) are rejected rather than silently filtered.

### Migration Notes (Scopes)

- Clients that previously passed `sender`/`recipient` addresses in request bodies to act on behalf of another wallet must instead authenticate as that wallet. Such fields are ignored for authorization and may be rejected by validation.
- Admin operations require the caller's wallet to be present in the admin allowlist (`ADMIN_PUBLIC_KEYS`).
- Public endpoints remain unauthenticated; no client change is required for them.
======>>> REPLACE

<<<<<<< SEARCH
## Configuration

### Environment Variables

```env
# Stellar Network (testnet or mainnet)
STELLAR_NETWORK=testnet

# For mainnet, use:
# STELLAR_NETWORK=mainnet
```
=======
## Configuration

### Environment Variables

```env
# Stellar Network (testnet or mainnet)
STELLAR_NETWORK=testnet

# For mainnet, use:
# STELLAR_NETWORK=mainnet

# Challenge lifetime in seconds (default 300)
AUTH_CHALLENGE_TTL_SECONDS=300

# Intended audience bound into each challenge
AUTH_AUDIENCE=flowfi-api

# Comma-separated admin wallet public keys
ADMIN_PUBLIC_KEYS=GADMIN1...,GADMIN2...
```

## Example: Creating a Signed Transaction (Client Side)

```javascript
import * as StellarSdk from '@stellar/stellar-sdk';

// Create a keypair (in real app, this comes from the user's wallet)
const keypair = StellarSdk.Keypair.fromSecret('S...');

// Get the current network passphrase
const networkPassphrase = StellarSdk.Networks.TESTNET;

// Create a simple transaction for authentication
const account = await server.loadAccount(keypair.publicKey());
const transaction = new StellarSdk.TransactionBuilder(account, {
  fee: StellarSdk.BASE_FEE,
  networkPassphrase,
})
  .addOperation(
    StellarSdk.Operation.manageData({
      name: 'auth',
      value: crypto.randomBytes(32), // Random challenge
    })
  )
  .setTimeout(300) // 5 minutes validity
  .build();

// Sign the transaction
transaction.sign(keypair);

// Encode to XDR for the Bearer token
const xdr = transaction.toEnvelope().toXDR('base64');

// Use in Authorization header
const response = await fetch('http://localhost:3001/v1/users/me', {
  headers: {
    'Authorization': `Bearer ${xdr}`
  }
});
```

## Error Responses

### 401 Unauthorized - Missing Token

```json
{
  "error": "Unauthorized",
  "message": "Missing or invalid Authorization header. Expected format: Bearer <signed_transaction>"
}
```

### 401 Unauthorized - Invalid Signature

```json
{
  "error": "Unauthorized",
  "message": "Invalid or expired signature"
}
```

## Security Features

1. **Signature Verification**: Cryptographically verifies the transaction was signed by the claimed public key
2. **Time Bounds**: Supports transaction time bounds to prevent replay attacks
3. **Network Validation**: Ensures transactions match the configured Stellar network
4. **No Password Storage**: No sensitive credentials stored on the server

## Configuration

### Environment Variables

```env
# Stellar Network (testnet or mainnet)
STELLAR_NETWORK=testnet

# For mainnet, use:
# STELLAR_NETWORK=mainnet
```

### Network Passphrases

- **Testnet**: `Test SDF Network ; September 2015`
- **Mainnet**: `Public Global Stellar Network ; September 2015`

## Independence from Database

Per issue #74 requirements, the middleware operates independently of the database:

- **User Exists**: Returns user data from database
- **User Missing**: Returns in-memory user object with `publicKey` and empty arrays
- **Never Blocks**: Authentication succeeds based solely on valid signature

Example in-memory response:

```json
{
  "publicKey": "GABC123...",
  "sentStreams": [],
  "receivedStreams": [],
  "inMemory": true
}
```

## TypeScript Types

### AuthUser

```typescript
interface AuthUser {
  publicKey: string;
  id?: string;
}
```

### AuthenticatedRequest

```typescript
interface AuthenticatedRequest extends Request {
  user: AuthUser;
}
```

### Usage in Controllers

```typescript
import type { AuthenticatedRequest } from '../types/auth.types.js';

export const getCurrentUser = async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  const { publicKey } = authReq.user;

  // Use publicKey...
};
```

## Testing

Test the middleware with a valid signed transaction:

```bash
# 1. Create a test transaction (use stellar-sdk)
# 2. Sign it with a test keypair
# 3. Encode to XDR
# 4. Send request

curl -X GET http://localhost:3001/v1/users/me \
  -H "Authorization: Bearer <your_signed_transaction_xdr>"
```

## OpenAPI Parity in CI

`backend/swagger/flowfi.openapi.json` is generated from the route definitions and validated in CI. The pipeline fails when:

- The committed spec differs from the generated artifact (drift)
- A route is missing from the spec, or the spec documents a route that no longer exists
- Documented request/response schemas, status codes, or auth requirements diverge from the implementation
- Error responses (`400`, `401`, `403`, `500`) are not documented for protected endpoints

Generated artifacts are reproducible: running the generator twice produces byte-identical output. All versioned endpoints (`/v1/*`) and their error responses are included.

### Operational Impact

- Contributors must regenerate the spec (`npm run openapi:generate`) and commit the result when changing routes, schemas, status codes, or auth.
- A deliberate spec mismatch fails CI, preventing undocumented API changes from merging.
- No runtime behavior changes; this is a build/CI gate only.

## Related Documentation

- [Stellar SEP-10 Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)
- [Stellar SDK Documentation](https://stellar.github.io/js-stellar-sdk/)
- [Swagger API Docs](http://localhost:3001/api-docs)
