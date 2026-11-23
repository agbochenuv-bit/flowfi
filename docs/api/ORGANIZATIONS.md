# Organizations API

Wallet-linked organization membership for shared payroll and subscription
workflows. Personal wallet ownership and signing authority remain distinct from
organization membership: a wallet owns its own key pair and signs on its own
behalf; membership only grants the right to act on organization-scoped
resources according to a role.

## Scope

- [#233] Invitation, acceptance, removal, and role checks for organization
  membership.
- [#234] Organization-level role and policy enforcement via a published
  role/action matrix.
- [#235] Operator-facing treasury balance and liability summary.
- [#236] Stable multi-network resource identities: every organization and its
  members are scoped to a single Stellar network.

## Base path

All endpoints are versioned under `/v1`. The version prefix is stripped by the
API versioning middleware, so paths below are relative (e.g.
`/organizations` not `/v1/organizations`).

## Network scoping

Every organization-scoped request must resolve a Stellar network. Resolution
order:

1. `X-Stellar-Network` request header (e.g. `testnet`, `mainnet`)
2. `network` query parameter
3. The server-configured network (`STELLAR_NETWORK` env, defaults to `testnet`)

Identical organization slugs on different networks are distinct resources and
cannot collide. Existing clients that omit a network are served against the
configured network; clients that relied on implicit single-network behavior
should migrate to sending an explicit network header before relying on
organization-scoped resources.

## Authentication

All organization routes require a wallet-authenticated session
(`POST /v1/auth/verify`). The caller's wallet public key is the subject used for
membership and role checks.

## Role / action matrix

Authorization is driven by a single published matrix. A role is authorized for
an action when the action is present in its set.

| Action | OWNER | ADMIN | MEMBER |
|---|---:|---:|---:|
| `organization:read` | yes | yes | yes |
| `organization:update` | yes | yes | no |
| `organization:delete` | yes | no | no |
| `member:invite` | yes | yes | no |
| `member:accept` | yes | yes | yes |
| `member:remove` | yes | yes | no |
| `member:list` | yes | yes | yes |
| `role:change` | yes | yes | no |
| `treasury:read` | yes | yes | yes |
| `network:resolve` | yes | yes | yes |

OWNER covers every action. ADMIN covers all administrative and read actions but
cannot delete the organization. MEMBER is read-only plus accepting invitations
and listing members.

## Endpoints

### Create an organization

`POST /organizations`

Body:
```json
{
  "name": "Acme Payroll",
  "slug": "acme-payroll",
  "network": "testnet"
}
```

The caller becomes the organization owner (OWNER). The slug must be unique on
the chosen network; otherwise the request returns `409`.

Response (201):
```json
{
  "id": "550e8400-...",
  "slug": "acme-payroll",
  "network": "testnet",
  "ownerWalletAddress": "GABC..."
}
```

### List members

`GET /organizations/:organizationId/members`

Requires any role (`member:list`). Returns the members of the organization on
the request's network.

Response (200):
```json
{
  "members": [
    {
      "walletAddress": "GABC...",
      "role": "OWNER",
      "invitedBy": null,
      "joinedAt": "2026-11-20T00:00:00Z"
    }
  ]
}
```

### Invite a member

`POST /organizations/:organizationId/invitations`

Requires `OWNER` or `ADMIN` (`member:invite`). Issues a single-use,
time-bound invitation (7 days) for a wallet to join at the given role.

Body:
```json
{
  "walletAddress": "GDEF...",
  "role": "MEMBER"
}
```

Response (201): `{ "token": "a1b2...", "expiresAt": "..." }`

The invitee accepts with `POST /organizations/invitations/:token/accept`.

### Accept an invitation

`POST /organizations/invitations/:token/accept`

Requires wallet authentication. The invitation must be `PENDING`, unexpired,
and addressed to the authenticated wallet. Acceptance creates a membership and
marks the invitation `ACCEPTED`. Idempotent when a membership already exists.

Response (200):
```json
{
  "organizationId": "550e8400-...",
  "organizationSlug": "acme-payroll",
  "network": "testnet",
  "role": "MEMBER"
}
```

### Remove a member

`DELETE /organizations/:organizationId/members/:walletAddress`

Requires `OWNER` or `ADMIN` (`member:remove`). The last OWNER cannot remove
themselves; ownership must be transferred first.

Response (200): `{ "removed": true }`

### Treasury summary

`GET /organizations/:organizationId/treasury/summary`

Requires `OWNER` or `ADMIN` (`treasury:read`). Operator-facing view reconciling
configured treasury assets, recorded fees, and outstanding payment liabilities
against the source ledger (issue #235).

Response (200):
```json
{
  "organizationId": "550e8400-...",
  "network": "testnet",
  "sourceLedger": { "ledgerSequence": 12345678, "processedAt": "2026-11-20T00:00:00Z" },
  "reconciliationStatus": "reconciled",
  "assets": [
    { "token": "C...", "deposited": "10000", "withdrawn": "2500", "balance": "7500" }
  ],
  "recordedFees": { "USDC": "2500" },
  "outstandingLiabilities": "7500",
  "computedAt": "2026-11-20T00:00:00Z"
}
```

`reconciliationStatus` is `reconciled` when a non-reverted ledger checkpoint
exists, `stale` when only indexer state exists, and `unknown` when neither is
available.

## Errors

Organization routes return the standard versioned error envelope:
```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Organization not found on this network",
    "requestId": "...",
    "version": 1
  }
}
```

Stable codes used by organization routes:
- `401 UNAUTHENTICATED` — missing or invalid session token
- `403 FORBIDDEN` — wallet is not a member, lacks the required role, or is the last owner
- `404 NOT_FOUND` — organization or membership not found on this network
- `409 CONFLICT` — organization slug already exists on this network, or resource is not scoped to the request's network

## Related documents

- `docs/api/README.md` — general API conventions and error envelope
- `docs/operations` — operator runbooks (treasury, revocation)
