# Authentication Middleware (SEP-10 + JWT)

FlowFi API uses the Stellar SEP-10 challenge flow to authenticate wallets, then issues a JWT for subsequent API requests.

## Overview

Authentication is performed in two phases:

1. Client requests a challenge from `/v1/auth/challenge`
2. Client signs the challenge transaction and submits it to `/v1/auth/verify`
3. Server verifies the nonce and returns a JWT
4. Client uses `Authorization: Bearer <JWT>` for authenticated endpoints

This simplifies clients and standardizes authentication across all protected routes.

## Partner Onboarding: Credentials, Webhooks, and Go-Live

External partners integrate in two isolated environments. **Testnet and production never share credentials, endpoints, or secrets.** Complete and validate the testnet path end-to-end before requesting production access.

### 1. Configure credentials (per environment)

Each environment has its own values. Never copy a testnet secret into production or vice versa.

| Setting | Testnet | Production |
| --- | --- | --- |
| API base URL | `https://api.testnet.flowfi.example` | `https://api.flowfi.example` |
| Stellar network passphrase | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` |
| `AUTH_AUDIENCE` | `flowfi-testnet` | `flowfi-production` |
| Partner API key | issued per testnet app | issued per production app (separate) |
| Webhook signing secret | testnet-only secret | production-only secret |

Store secrets in your secret manager, never in source control. The server only ever sees your Stellar **public** key and signed challenges — it never receives your secret key.

### 2. Validate webhook handling

Webhooks are signed. Verify the signature against the **environment-specific** signing secret before trusting the payload, and reject on mismatch.

```bash
# Runnable testnet sample: send a signed test event to your handler
curl -X POST "$PARTNER_WEBHOOK_URL" \
  -H "Content-Type: application/json" \
  -H "X-FlowFi-Signature: $(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | sed 's/^.* //')" \
  -d "$BODY"
```

Checklist:

- [ ] Handler rejects requests with a missing or invalid `X-FlowFi-Signature` (expect `401`).
- [ ] Handler rejects a payload signed with the *other* environment's secret (testnet/production mismatch).
- [ ] Handler is idempotent on duplicate delivery (dedupe by event id).
- [ ] Handler returns `2xx` quickly and processes asynchronously.

### 3. Test reconciliation

Reconciliation confirms your ledger matches FlowFi's reported state.

```bash
# Runnable testnet sample: fetch settled transactions for a window
curl -X GET "$API_BASE_URL/v1/transactions?from=$FROM&to=$TO" \
  -H "Authorization: Bearer $JWT"
```

Checklist:

- [ ] Sum of your recorded amounts equals the API-reported totals for the window.
- [ ] Boundary cases pass: empty window, single transaction, and a window spanning a settlement cutoff.
- [ ] A deliberately mismatched record is detected and surfaced, not silently dropped.

### 4. Clean-environment validation before go-live

Before publication/production access, run the full flow from a **clean environment** (fresh credentials, empty state, no cached tokens):

1. Request a challenge, sign it, and exchange it for a JWT (see [Wallet Challenges](#wallet-challenges-single-use-replay-resistant)).
2. Confirm a reused challenge is rejected with `401 CHALLENGE_ALREADY_USED`.
3. Confirm a challenge signed for the wrong network is rejected with `401 CHALLENGE_NETWORK_MISMATCH`.
4. Deliver a signed webhook and confirm acceptance; deliver a bad-signature webhook and confirm rejection.
5. Run reconciliation and confirm totals match.

Only after every step passes on testnet should you request production credentials and repeat steps 1–5 against production with production-only secrets.

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

## Key Lifecycle: User Wallets vs. Operator Identities

Authentication distinguishes two key classes. The full decision matrix — ownership, signer responsibilities, rotation, revocation, and incident steps — lives in [`docs/security/key-lifecycle-matrix.md`](../../docs/security/key-lifecycle-matrix.md). Summary:

| Aspect | Non-custodial user wallet | Explicitly custodial flow | Operator / service identity |
| --- | --- | --- | --- |
| Key holder | End user (client-side signer) | FlowFi-managed signer (only where a flow is explicitly custodial) | FlowFi operators / service accounts |
| Server sees | Public key + signed challenge only | Public key + delegated signing authority | Service credentials, never user secrets |
| Signer responsibility | User signs SEP-10 challenge and any transaction | FlowFi signs on the user's behalf under documented custody controls | Operator signs/authorizes via managed credentials |
| Rotation | User rotates their own Stellar keys; server re-binds on next login | FlowFi rotates the custodial signer per the matrix | Scheduled + on-incident rotation per the matrix |
| Revocation | User stops using the key; server rejects stale challenges | FlowFi revokes the custodial signer and re-issues | Operator access revoked immediately on offboarding/incident |

- **Non-custodial (default):** FlowFi never holds user secret keys. The server only verifies signatures against the public key presented in the SEP-10 challenge.
- **Custodial (explicit only):** Any flow where FlowFi holds or controls signing material must be explicitly documented as custodial and gated by the controls referenced in the matrix. Do not describe a flow as non-custodial if FlowFi can sign on the user's behalf.
- **Operator / service identities:** Managed separately from user wallets; see the matrix for rotation cadence, revocation, and incident response.

Related controls: [`SECURITY.md`](../../SECURITY.md), [`.github/SECURITY_SETUP_CHECKLIST.md`](../../.github/SECURITY_SETUP_CHECKLIST.md). Never publish operational secrets, private keys, or seed phrases in this or any doc.

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
- `requestId` is additive; clients may log it for support correlation.
