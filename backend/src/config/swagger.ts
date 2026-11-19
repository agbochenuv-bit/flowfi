import swaggerJsdoc from 'swagger-jsdoc';

/**
 * Recursively sorts object keys so the generated spec is byte-for-byte
 * reproducible across runs (and therefore safe to diff in CI parity checks).
 * Arrays keep their declared order because ordering is meaningful there
 * (e.g. `required`, `enum`, `tags`, `servers`).
 */
function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted as T;
  }
  return value;
}

/**
 * Canonical error responses shared by every versioned endpoint. Route-level
 * `@openapi` annotations reference these via `$ref` so status codes and
 * payload shapes cannot drift between routes.
 */
const errorResponses = {
  BadRequest: {
    description: 'Malformed request (invalid JSON, query or path parameters)',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  Unauthorized: {
    description: 'Missing, malformed or expired bearer token',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  Forbidden: {
    description: 'Authenticated but not permitted to perform this action',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  NotFound: {
    description: 'Requested resource does not exist',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  Conflict: {
    description: 'Request conflicts with the current state of the resource',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  StreamVersionConflict: {
    description: `The mutation was rejected because the stream changed after the client reviewed it.

Clients must submit the \`stateVersion\` they reviewed (via the \`If-Match\` header or the
\`stateVersion\` request body field). When the current version differs, the request is rejected
with HTTP 409 and \`error.code = "STREAM_VERSION_CONFLICT"\`. The response includes the current
version metadata so the client can re-read the stream and retry.

**Wallet-signed semantics:** This check is a preflight guard only. It never replaces the
wallet signature or on-chain authorization — the signed transaction must still be authorized
by the wallet and validated by the contract.`,
    content: {
      'application/json': {
        schema: {
          allOf: [
            { $ref: '#/components/schemas/ErrorEnvelope' },
            {
              type: 'object',
              properties: {
                error: {
                  type: 'object',
                  properties: {
                    code: { type: 'string', enum: ['STREAM_VERSION_CONFLICT'], example: 'STREAM_VERSION_CONFLICT' },
                    details: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/StreamVersionConflictDetail' },
                    },
                  },
                },
              },
            },
          ],
        },
      },
    },
  },
  TooManyRequests: {
    description: 'Rate limit exceeded',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  InternalServerError: {
    description: 'Unexpected server error',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
} as const;

const options: swaggerJsdoc.Options = {
  definition: {
    openapi: '3.1.0',
    info: {
      title: 'FlowFi API',
      version: '1.0.0',
      description: `API documentation for FlowFi - Real-time payment streaming on Stellar

## Performance & Caching
The API implements caching for frequently accessed endpoints, such as claimable amount calculations. 
- **Claimable Cache TTL**: 5 seconds
- **Invalidation**: Automatically cleared when a withdrawal event occurs.

## Sandbox Mode

FlowFi API supports sandbox mode for testing without affecting production data.

**Enable Sandbox Mode:**
- Header: \`X-Sandbox-Mode: true\`
- Query Parameter: \`?sandbox=true\`

**Sandbox Features:**
- Isolated database (separate from production)
- All responses include \`_sandbox\` metadata
- Response headers include \`X-Sandbox-Mode: true\`
- Safe for testing and development

See [Sandbox Mode Documentation](../docs/SANDBOX_MODE.md) for details.

## Error Envelope (v1)

All REST endpoints return a stable, versioned error envelope on failure:

\`\`\`json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "requestId": "3f1c2b9e-8a4d-4c6e-9f2a-1b7d5e0c9a83",
    "version": 1,
    "details": [{ "field": "recipient", "message": "must be a valid Stellar public key" }]
  }
}
\`\`\`

- \`code\` is a stable machine-readable identifier — switch on it, not on \`message\`.
- \`message\` is always safe; internal exception text is never exposed.
- \`requestId\` matches the \`X-Request-Id\` response header for log correlation.
- \`details\` is present for validation failures.

**Migration:** This is an additive, backward-compatible change. Existing \`error.code\`/\`error.message\`
consumers are unaffected. Unknown codes should be treated as generic failures.

## Optimistic Concurrency (Stream Mutations)

Stream mutations accept the state version the client reviewed, via the \`If-Match\` header
(\`If-Match: "<stateVersion>"\`) or a \`stateVersion\` body field. If the stream changed in the
meantime the API returns HTTP 409 with \`error.code = "STREAM_VERSION_CONFLICT"\` and the current
version metadata in \`error.details\`. This is a preflight guard only — wallet signatures and
on-chain authorization remain authoritative.

## Token Metadata Provenance

Token metadata objects carry \`trustLevel\` (\`verified\` | \`curated\` | \`hint\` | \`unknown\`),
\`source\`, \`stale\` and \`fetchedAt\` so clients can distinguish verified data from hints. Raw
on-chain amounts are always base-unit integer strings and are never rescaled by metadata.

## Action Readiness

\`GET /v1/streams/{id}/readiness?action=...\` returns stable check codes with \`blocker\` vs
\`warning\` severity. Readiness is advisory: it never promises transaction success, and state may
change between the check and submission.

## Wallet Sessions

\`GET /v1/auth/sessions\` lists active wallet sessions (ids only, never signing secrets) and
\`DELETE /v1/auth/sessions/{id}\` revokes one immediately across REST and SSE. Sessions expire at
\`expiresAt\` and are not extended by activity.`,
      contact: {
        name: 'FlowFi Team',
        url: 'https://github.com/LabsCrypt/flowfi',
      },
      license: {
        name: 'MIT',
        url: 'https://opensource.org/licenses/MIT',
      },
    },
    servers: (() => {
      const baseUrl = process.env.API_BASE_URL;
      if (baseUrl) {
        return [{ url: `${baseUrl}/v1`, description: 'API server' }];
      }
      return [
        { url: 'http://localhost:3001/v1', description: 'Development server (v1)' },
        { url: 'https://api.flowfi.io/v1', description: 'Production server (v1)' },
      ];
    })(),
    tags: [
      {
        name: 'Health',
        description: 'Health check endpoints',
      },
      {
        name: 'Users',
        description: 'User management endpoints',
      },
      {
        name: 'Streams',
        description: 'Payment stream management endpoints',
      },
      {
        name: 'Events',
        description: 'Stream event tracking endpoints',
      },
      {
        name: 'Admin',
        description: 'Administrative and monitoring endpoints',
      },
      {
        name: 'Observability',
        description: 'Prometheus metrics scrape endpoint',
      },
      {
        name: 'Sessions',
        description: 'Wallet-authenticated session inventory and revocation',
      },
      {
        name: 'Readiness',
        description: 'Preflight action readiness checks (advisory, not a transaction guarantee)',
      },
    ],
    components: {
      responses: errorResponses,
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'JSON Web Token issued by /v1/auth/verify after completing the SEP-10 challenge flow.'
        },
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Alias for BearerAuth — used by route-level security annotations.'
        },
        adminAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Admin JWT — the token subject must match ADMIN_PUBLIC_KEY.'
        }
      },
      schemas: {
        User: {
          type: 'object',
          required: ['id', 'publicKey'],
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              description: 'Unique identifier for the user',
              example: '550e8400-e29b-41d4-a716-446655440000',
            },
            publicKey: {
              type: 'string',
              description: 'Stellar public key (G...)',
              example: 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA',
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              description: 'User creation timestamp',
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
              description: 'Last update timestamp',
            },
          },
        },
        Stream: {
          type: 'object',
          required: ['id', 'streamId', 'sender', 'recipient', 'tokenAddress', 'ratePerSecond'],
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              description: 'Database UUID',
            },
            streamId: {
              type: 'integer',
              description: 'On-chain stream ID',
              example: 1,
            },
            sender: {
              type: 'string',
              description: 'Sender Stellar public key',
              example: 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA',
            },
            recipient: {
              type: 'string',
              description: 'Recipient Stellar public key',
              example: 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD',
            },
            tokenAddress: {
              type: 'string',
              description: 'Token contract address',
              example: 'CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE',
            },
            ratePerSecond: {
              type: 'string',
              description: 'Payment rate per second (i128 as string)',
              example: '100',
            },
            depositedAmount: {
              type: 'string',
              description: 'Total deposited amount (i128 as string)',
              example: '10000',
            },
            withdrawnAmount: {
              type: 'string',
              description: 'Total withdrawn amount (i128 as string)',
              example: '2500',
            },
            startTime: {
              type: 'integer',
              description: 'Stream start time (Unix timestamp)',
              example: 1708531200,
            },
            lastUpdateTime: {
              type: 'integer',
              description: 'Last update time (Unix timestamp)',
              example: 1708534800,
            },
            isActive: {
              type: 'boolean',
              description: 'Stream active status',
              example: true,
            },
            isPaused: {
              type: 'boolean',
              description: 'Whether the stream is currently paused',
              example: false,
            },
            pausedAt: {
              type: 'integer',
              nullable: true,
              description: 'Ledger timestamp when the stream was last paused (Unix), null if not paused',
              example: null,
            },
            totalPausedDuration: {
              type: 'integer',
              description: 'Cumulative seconds the stream has spent paused',
              example: 0,
            },
            endTime: {
              type: 'integer',
              nullable: true,
              description: 'Ledger timestamp when the stream ended (Unix), null if still active',
              example: null,
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
            },
            updatedAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        StreamEvent: {
          type: 'object',
          required: ['id', 'streamId', 'eventType', 'transactionHash', 'ledgerSequence', 'timestamp'],
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
            },
            streamId: {
              type: 'integer',
              description: 'Reference to stream ID',
            },
            eventType: {
              type: 'string',
              enum: ['CREATED', 'TOPPED_UP', 'WITHDRAWN', 'CANCELLED', 'COMPLETED', 'PAUSED', 'RESUMED', 'FEE_COLLECTED'],
              description: 'Type of stream event',
              example: 'TOPPED_UP',
            },
            amount: {
              type: 'string',
              nullable: true,
              description: 'Amount involved in event (i128 as string)',
              example: '5000',
            },
            transactionHash: {
              type: 'string',
              description: 'Stellar transaction hash',
              example: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6',
            },
            ledgerSequence: {
              type: 'integer',
              description: 'Ledger sequence number',
              example: 12345678,
            },
            timestamp: {
              type: 'integer',
              description: 'Event timestamp (Unix)',
              example: 1708531200,
            },
            metadata: {
              type: 'string',
              nullable: true,
              description: 'Additional event data (JSON string)',
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        StreamListResponse: {
          type: 'object',
          required: ['data', 'total', 'hasMore', 'limit', 'offset'],
          properties: {
            data: {
              type: 'array',
              description: 'Streams matching the filter, sorted and paginated',
              items: { $ref: '#/components/schemas/Stream' },
            },
            total: { type: 'integer', description: 'Total number of streams matching the filter' },
            hasMore: { type: 'boolean', description: 'Whether more results are available past this page' },
            limit: { type: 'integer', description: 'Page size applied (capped at MAX_STREAM_PAGE_SIZE)' },
            offset: { type: 'integer', description: 'Number of results skipped' },
          },
        },
        StreamEventListResponse: {
          type: 'object',
          required: ['data', 'total', 'hasMore'],
          properties: {
            data: {
              type: 'array',
              description: 'Events for the stream, sorted by timestamp (tie-broken by id)',
              items: { $ref: '#/components/schemas/StreamEvent' },
            },
            total: { type: 'integer', description: 'Total number of events matching the filter' },
            hasMore: { type: 'boolean', description: 'Whether more results are available past this page' },
          },
        },
        EventListResponse: {
          type: 'object',
          required: ['events', 'total', 'limit', 'offset', 'hasMore'],
          properties: {
            events: {
              type: 'array',
              description: 'Reverse-chronological stream events for the wallet',
              items: { $ref: '#/components/schemas/StreamEvent' },
            },
            total: { type: 'integer', description: 'Total number of matching events' },
            limit: { type: 'integer', description: 'Page size applied (capped at 200)' },
            offset: { type: 'integer', description: 'Number of events skipped' },
            hasMore: { type: 'boolean', description: 'Whether more results are available past this page' },
          },
        },
        UserEventListResponse: {
          type: 'object',
          required: ['data', 'total', 'hasMore', 'limit', 'offset'],
          properties: {
            data: {
              type: 'array',
              description: 'Events associated with the user, newest first',
              items: { $ref: '#/components/schemas/StreamEvent' },
            },
            total: { type: 'integer', description: 'Total number of matching events' },
            hasMore: { type: 'boolean', description: 'Whether more results are available past this page' },
            limit: { type: 'integer', description: 'Page size applied (capped at 200)' },
            offset: { type: 'integer', description: 'Number of events skipped' },
          },
        },
        UserStreamSummary: {
          type: 'object',
          required: [
            'address',
            'totalStreamsCreated',
            'totalStreamedOut',
            'totalStreamedIn',
            'currentClaimable',
            'activeOutgoingCount',
            'activeIncomingCount',
          ],
          properties: {
            address: { type: 'string', description: 'Stellar public key' },
            totalStreamsCreated: { type: 'integer', description: 'Number of streams this wallet sent' },
            totalStreamedOut: { type: 'string', description: 'Sum of withdrawn amounts on outgoing streams (i128 as string)' },
            totalStreamedIn: { type: 'string', description: 'Sum of withdrawn amounts on incoming streams (i128 as string)' },
            currentClaimable: { type: 'string', description: 'Total currently claimable across active incoming streams (i128 as string)' },
            activeOutgoingCount: { type: 'integer' },
            activeIncomingCount: { type: 'integer' },
            truncated: { type: 'boolean', description: 'True when the number of streams was capped at MAX_USER_STREAMS per direction', example: false },
          },
        },
        ClaimableResponse: {
          type: 'object',
          required: ['claimableAmount', 'actionable', 'calculatedAt'],
          properties: {
            streamId: { type: 'integer', description: 'On-chain stream ID' },
            ratePerSecond: { type: 'string', description: 'Payment rate per second (i128 as string)' },
            depositedAmount: { type: 'string', description: 'Total deposited amount (i128 as string)' },
            withdrawnAmount: { type: 'string', description: 'Total withdrawn amount (i128 as string)' },
            startTime: { type: 'integer', description: 'Stream start time (Unix timestamp)' },
            lastUpdateTime: { type: 'integer', description: 'Last state update time (Unix timestamp)' },
            claimableAmount: { type: 'string', description: 'Amount claimable at the requested time (i128 as string)' },
            actionable: { type: 'boolean', description: 'Whether the claimable amount is positive' },
            calculatedAt: { type: 'integer', description: 'Unix timestamp of the calculation' },
            cached: { type: 'boolean', description: 'Whether the value came from cache or a fresh computation' },
            source: { type: 'string', enum: ['db', 'chain'], description: 'Where the value was computed from' },
          },
        },
        StreamVersionConflictDetail: {
          type: 'object',
          required: ['field', 'message', 'expectedVersion', 'currentVersion'],
          properties: {
            field: { type: 'string', example: 'stateVersion' },
            message: { type: 'string', example: 'Stream state changed since the reviewed version' },
            code: { type: 'string', enum: ['STREAM_VERSION_CONFLICT'], example: 'STREAM_VERSION_CONFLICT' },
            expectedVersion: {
              type: 'integer',
              description: 'The state version the client submitted (what it reviewed)',
              example: 3,
            },
            currentVersion: {
              type: 'integer',
              description: 'The current state version of the stream; re-read and retry with this value',
              example: 4,
            },
            currentUpdatedAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description: 'Timestamp of the most recent state change, when known',
            },
            streamId: { type: 'integer', description: 'On-chain stream ID', example: 1 },
          },
        },
        TokenMetadata: {
          type: 'object',
          description: `Display metadata for a token, annotated with provenance and freshness so clients can
distinguish verified data from hints.

**Trust levels (\`trustLevel\`):**
- \`verified\` — metadata was read from the token contract itself (on-chain \`name\`/\`decimals\`).
- \`curated\` — metadata came from the operator-maintained allowlist.
- \`hint\` — metadata came from an unverified third-party source; display only, never use for accounting.
- \`unknown\` — no metadata source was available; \`name\`/\`symbol\` are null and \`decimals\` is null.

**Fallback behavior:** sources are tried in order verified → curated → hint. If all fail, the
object is returned with \`trustLevel: "unknown"\` and \`stale: true\`. Raw on-chain amounts are
never altered by metadata: \`amount\` fields remain base-unit integer strings regardless of
\`decimals\` or trust level.`,
          required: ['tokenAddress', 'trustLevel', 'stale'],
          properties: {
            tokenAddress: {
              type: 'string',
              description: 'Token contract address',
              example: 'CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE',
            },
            name: { type: 'string', nullable: true, description: 'Human-readable token name, null when unavailable', example: 'USD Coin' },
            symbol: { type: 'string', nullable: true, description: 'Token symbol, null when unavailable', example: 'USDC' },
            decimals: {
              type: 'integer',
              nullable: true,
              description: 'Display decimals hint; never applied to raw on-chain amounts by the API',
              example: 7,
            },
            trustLevel: {
              type: 'string',
              enum: ['verified', 'curated', 'hint', 'unknown'],
              description: 'Provenance of the metadata; see schema description for semantics',
              example: 'verified',
            },
            source: {
              type: 'string',
              enum: ['contract', 'allowlist', 'third_party', 'none'],
              description: 'Concrete source that produced this metadata',
              example: 'contract',
            },
            stale: {
              type: 'boolean',
              description: 'True when the metadata is older than the freshness window or could not be refreshed',
              example: false,
            },
            fetchedAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description: 'When the metadata was last successfully fetched, null when never fetched',
            },
            staleAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description: 'When the metadata becomes (or became) stale, null when it does not expire',
            },
            error: {
              type: 'string',
              nullable: true,
              description: 'Safe reason metadata could not be refreshed (e.g. malformed or unavailable source)',
            },
          },
        },
        ReadinessCheck: {
          type: 'object',
          required: ['code', 'severity', 'passed', 'message'],
          properties: {
            code: {
              type: 'string',
              description: `Stable machine-readable check code. Switch on this, not on \`message\`.
Codes are grouped by category:
- Authorization: \`WALLET_NOT_AUTHENTICATED\`, \`WALLET_NOT_AUTHORIZED\`, \`SESSION_REVOKED\`
- Network: \`NETWORK_MISMATCH\`, \`SOROBAN_RPC_UNAVAILABLE\`
- Asset: \`TOKEN_METADATA_UNKNOWN\`, \`INSUFFICIENT_BALANCE\`, \`INSUFFICIENT_ALLOWANCE\`
- Freshness: \`STREAM_STATE_STALE\`, \`STREAM_VERSION_MISMATCH\`, \`STREAM_INACTIVE\`
- Input: \`INVALID_AMOUNT\`, \`AMOUNT_EXCEEDS_CLAIMABLE\``,
              enum: [
                'WALLET_NOT_AUTHENTICATED',
                'WALLET_NOT_AUTHORIZED',
                'SESSION_REVOKED',
                'NETWORK_MISMATCH',
                'SOROBAN_RPC_UNAVAILABLE',
                'TOKEN_METADATA_UNKNOWN',
                'INSUFFICIENT_BALANCE',
                'INSUFFICIENT_ALLOWANCE',
                'STREAM_STATE_STALE',
                'STREAM_VERSION_MISMATCH',
                'STREAM_INACTIVE',
                'INVALID_AMOUNT',
                'AMOUNT_EXCEEDS_CLAIMABLE',
              ],
              example: 'STREAM_VERSION_MISMATCH',
            },
            severity: {
              type: 'string',
              enum: ['blocker', 'warning'],
              description: '`blocker` means the action is expected to fail; `warning` means it may still succeed',
              example: 'blocker',
            },
            passed: {
              type: 'boolean',
              description: 'True when the check passed; false for both blockers and warnings that did not pass',
              example: false,
            },
            message: { type: 'string', description: 'Safe human-readable explanation', example: 'Stream state changed since the reviewed version' },
            category: {
              type: 'string',
              enum: ['authorization', 'network', 'asset', 'freshness', 'input'],
              description: 'Category the check belongs to',
              example: 'freshness',
            },
          },
        },
        ActionReadinessResponse: {
          type: 'object',
          description: `Preflight readiness for a stream action. This is advisory only and never promises
transaction success: the wallet signature, contract constraints and on-chain state at execution
time remain authoritative.

**Race conditions:** checks are evaluated against a snapshot at \`evaluatedAt\`. State can change
between this response and transaction submission (another client may mutate the stream, the
network may change, balances may move). Clients should submit the reviewed \`stateVersion\` with
the mutation and handle \`STREAM_VERSION_CONFLICT\` (HTTP 409) by re-running readiness.`,
          required: ['action', 'streamId', 'ready', 'blockers', 'warnings', 'checks', 'evaluatedAt'],
          properties: {
            action: {
              type: 'string',
              enum: ['withdraw', 'top_up', 'pause', 'resume', 'cancel'],
              description: 'Action the readiness was evaluated for',
              example: 'withdraw',
            },
            streamId: { type: 'integer', description: 'On-chain stream ID', example: 1 },
            ready: {
              type: 'boolean',
              description: 'True when no blocker failed; warnings do not affect this value',
              example: false,
            },
            stateVersion: {
              type: 'integer',
              description: 'Stream state version the checks were evaluated against; submit this with the mutation',
              example: 4,
            },
            blockers: {
              type: 'array',
              description: 'Failed checks with severity `blocker`',
              items: { $ref: '#/components/schemas/ReadinessCheck' },
            },
            warnings: {
              type: 'array',
              description: 'Failed checks with severity `warning`',
              items: { $ref: '#/components/schemas/ReadinessCheck' },
            },
            checks: {
              type: 'array',
              description: 'All evaluated checks, passed or not',
              items: { $ref: '#/components/schemas/ReadinessCheck' },
            },
            evaluatedAt: { type: 'string', format: 'date-time', description: 'When the snapshot was evaluated' },
          },
        },
        WalletSession: {
          type: 'object',
          description: `A wallet-authenticated session. Only non-secret identifiers are exposed: the
session id, the wallet public key, and coarse client metadata. Signing secrets, JWTs and
challenge nonces are never returned.`,
          required: ['id', 'publicKey', 'createdAt', 'lastSeenAt', 'expiresAt', 'current'],
          properties: {
            id: {
              type: 'string',
              format: 'uuid',
              description: 'Opaque session identifier (safe to display and to revoke)',
              example: '550e8400-e29b-41d4-a716-446655440000',
            },
            publicKey: {
              type: 'string',
              description: 'Stellar public key the session was authenticated for',
              example: 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA',
            },
            createdAt: { type: 'string', format: 'date-time', description: 'When the session was created' },
            lastSeenAt: { type: 'string', format: 'date-time', description: 'Last request made with this session' },
            expiresAt: {
              type: 'string',
              format: 'date-time',
              description: 'Absolute expiry. Sessions are not extended by activity; re-authenticate after expiry.',
            },
            revokedAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description: 'When the session was revoked, null while active',
            },
            current: {
              type: 'boolean',
              description: 'True for the session making the request',
              example: false,
            },
            userAgent: { type: 'string', nullable: true, description: 'Coarse client hint captured at creation' },
            ipHint: { type: 'string', nullable: true, description: 'Truncated client IP hint captured at creation' },
          },
        },
        WalletSessionListResponse: {
          type: 'object',
          required: ['data', 'total'],
          properties: {
            data: {
              type: 'array',
              description: 'Active (non-revoked, non-expired) sessions for the authenticated wallet, newest first',
              items: { $ref: '#/components/schemas/WalletSession' },
            },
            total: { type: 'integer', description: 'Number of active sessions' },
          },
        },
        RevokeSessionResponse: {
          type: 'object',
          required: ['id', 'revokedAt'],
          properties: {
            id: { type: 'string', format: 'uuid', description: 'Revoked session id' },
            revokedAt: { type: 'string', format: 'date-time', description: 'When revocation took effect' },
            alreadyRevoked: {
              type: 'boolean',
              description: 'True when the session was already revoked (idempotent success)',
              example: false,
            },
          },
        },
        PauseResumeResponse: {
          type: 'object',
          required: ['success', 'streamId', 'txHash'],
          properties: {
            success: { type: 'boolean', example: true },
            streamId: { type: 'integer' },
            txHash: { type: 'string', description: 'Stellar transaction hash of the pause/resume simulation' },
            stream: { $ref: '#/components/schemas/Stream' },
          },
        },
        TopUpResponse: {
          type: 'object',
          required: ['streamId', 'txHash', 'depositedAmount'],
          properties: {
            streamId: { type: 'integer' },
            txHash: { type: 'string', description: 'Stellar transaction hash' },
            depositedAmount: { type: 'string', description: 'New total deposited amount after the top-up (i128 as string)' },
          },
        },
        WithdrawResponse: {
          type: 'object',
          required: ['success', 'streamId', 'txHash', 'amount'],
          properties: {
            success: { type: 'boolean', example: true },
            streamId: { type: 'integer' },
            txHash: { type: 'string', description: 'Stellar transaction hash of the withdrawal' },
            amount: { type: 'string', description: 'Amount withdrawn (i128 as string)' },
            stream: { $ref: '#/components/schemas/Stream' },
          },
        },
        CancelResponse: {
          type: 'object',
          required: ['txHash', 'status'],
          properties: {
            txHash: { type: 'string', description: 'Stellar transaction hash of the cancel' },
            status: { type: 'string', enum: ['CANCELLED'], example: 'CANCELLED' },
          },
        },
        AuthChallengeResponse: {
          type: 'object',
          required: ['nonce', 'expiresAt'],
          properties: {
            nonce: { type: 'string', description: 'Hex-encoded nonce to sign via a Stellar manage_data operation' },
            expiresAt: { type: 'integer', description: 'Unix timestamp (ms) when the challenge expires (60s)' },
          },
        },
        AuthVerifyResponse: {
          type: 'object',
          required: ['token', 'expiresIn'],
          properties: {
            token: { type: 'string', description: 'JWT to use in the Authorization: Bearer header' },
            expiresIn: { type: 'integer', description: 'Token lifetime in seconds (3600)' },
          },
        },
        SseStats: {
          type: 'object',
          required: ['activeConnections', 'activeIps', 'perIpPeakConnections', 'maxConnections', 'timestamp'],
          properties: {
            activeConnections: { type: 'integer', example: 42 },
            activeIps: { type: 'integer', example: 8 },
            perIpPeakConnections: { type: 'integer', example: 5 },
            maxConnections: { type: 'integer', example: 10000 },
            timestamp: { type: 'string', format: 'date-time' },
          },
        },
        WebhookSubscription: {
          type: 'object',
          required: ['id', 'userAddress', 'targetUrl', 'eventTypes', 'active', 'createdAt'],
          properties: {
            id: { type: 'string', description: 'Webhook subscription id' },
            userAddress: { type: 'string', description: 'Stellar public key the subscription belongs to' },
            targetUrl: { type: 'string', description: 'HTTPS endpoint receiving the events' },
            eventTypes: {
              type: 'array',
              items: { type: 'string', enum: ['CREATED', 'TOPPED_UP', 'WITHDRAWN', 'CANCELLED', 'COMPLETED', 'PAUSED', 'RESUMED', 'FEE_COLLECTED'] },
            },
            active: { type: 'boolean' },
            createdAt: { type: 'string', format: 'date-time' },
          },
        },
        HealthResponse: {
          type: 'object',
          required: ['status', 'db', 'indexerEnabled', 'uptime', 'checks'],
          properties: {
            status: { type: 'string', enum: ['ok', 'degraded'], example: 'ok' },
            db: { type: 'string', enum: ['connected', 'disconnected'], example: 'connected' },
            indexerEnabled: { type: 'boolean', description: 'Whether the event indexer is configured' },
            indexerLag: { type: 'integer', nullable: true, description: 'Seconds since last indexer update, or null when no state row exists yet' },
            eventsProcessed: { type: 'integer', description: 'Lifetime count of successfully processed indexer events' },
            eventsFailed: { type: 'integer', description: 'Lifetime count of indexer events that threw during processing' },
            lastErrorAt: { type: 'string', format: 'date-time', nullable: true, description: 'Most recent per-event processing failure' },
            indexerDegraded: { type: 'boolean', description: 'True when recent event-processing failure rate spikes' },
            uptime: { type: 'number', description: 'Server uptime in seconds' },
            checks: {
              type: 'object',
              description: 'Per-subsystem status breakdown',
              properties: {
                database: {
                  type: 'object',
                  properties: { status: { type: 'string', enum: ['ok', 'down'] } },
                },
                indexer: {
                  type: 'object',
                  properties: {
                    status: { type: 'string', enum: ['ok', 'degraded', 'disabled'] },
                    enabled: { type: 'boolean' },
                    lagSeconds: { type: 'integer', nullable: true },
                  },
                },
                redis: {
                  type: 'object',
                  properties: { status: { type: 'string', enum: ['ok', 'unavailable', 'not_configured'] } },
                },
                sorobanRpc: {
                  type: 'object',
                  properties: { status: { type: 'string', enum: ['ok', 'down'] } },
                },
              },
            },
          },
        },
        ErrorEnvelope: {
          type: 'object',
          description: `Stable, versioned error envelope returned by every REST endpoint on failure.

**Version:** \`1\` (see \`error.version\`). The envelope is additive and backward compatible:
existing clients that read \`error.code\` and \`error.message\` keep working, while new clients can
rely on \`error.requestId\` for correlation and \`error.details\` for structured validation issues.

**Guarantees:**
- \`error.code\` is a stable, machine-readable identifier (see \`ErrorCode\`). It never changes meaning within a major version.
- \`error.message\` is a safe, human-readable summary. Internal exception text, stack traces, SQL, and
  upstream provider payloads are never exposed.
- \`error.requestId\` echoes the \`X-Request-Id\` response header for log correlation.
- \`error.details\` is present for validation failures and lists field-level issues.

**Migration:** No breaking change. Clients should switch on \`error.code\` rather than parsing
\`error.message\`. Unknown codes must be treated as generic failures.`,
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId', 'version'],
              properties: {
                code: {
                  type: 'string',
                  description: 'Stable machine-readable error code',
                  enum: [
                    'VALIDATION_ERROR',
                    'UNAUTHORIZED',
                    'FORBIDDEN',
                    'NOT_FOUND',
                    'CONFLICT',
                    'RATE_LIMITED',
                    'PAYLOAD_TOO_LARGE',
                    'UNSUPPORTED_MEDIA_TYPE',
                    'UPSTREAM_UNAVAILABLE',
                    'INTERNAL_ERROR',
                  ],
                  example: 'NOT_FOUND',
                },
                message: {
                  type: 'string',
                  description: 'Safe human-readable message; never contains internal exception text',
                  example: 'Resource not found',
                },
                requestId: {
                  type: 'string',
                  description: 'Correlation id, also returned in the X-Request-Id response header',
                  example: '3f1c2b9e-8a4d-4c6e-9f2a-1b7d5e0c9a83',
                },
                version: {
                  type: 'integer',
                  description: 'Error envelope contract version',
                  enum: [1],
                  example: 1,
                },
                details: {
                  type: 'array',
                  description: 'Structured validation issues when applicable',
                  items: {
                    type: 'object',
                    required: ['field', 'message'],
                    properties: {
                      field: { type: 'string', description: 'Dot-path of the offending field', example: 'recipient' },
                      message: { type: 'string', description: 'Safe description of the issue', example: 'must be a valid Stellar public key' },
                      code: { type: 'string', description: 'Optional field-level issue code', example: 'INVALID_FORMAT' },
                    },
                  },
                },
              },
            },
          },
        },
        Error: {
          description: 'Deprecated alias of ErrorEnvelope, retained for backward compatibility.',
          allOf: [{ $ref: '#/components/schemas/ErrorEnvelope' }],
        },
        CreateStreamRequest: {
          type: 'object',
          required: ['streamId', 'sender', 'recipient', 'tokenAddress', 'ratePerSecond', 'depositedAmount', 'startTime'],
          properties: {
            streamId: {
              oneOf: [{ type: 'integer' }, { type: 'string' }],
              description: 'On-chain stream ID (non-negative integer)',
              example: 1,
            },
            sender: {
              type: 'string',
              description: 'Sender Stellar public key',
              example: 'GABC123XYZ456DEF789GHI012JKL345MNO678PQR901STU234VWX567YZA',
            },
            recipient: {
              type: 'string',
              description: 'Recipient Stellar public key',
              example: 'GDEF456ABC789GHI012JKL345MNO678PQR901STU234VWX567YZA123BCD',
            },
            tokenAddress: {
              type: 'string',
              description: 'Token contract address',
              example: 'CBCD789EFG012HIJ345KLM678NOP901QRS234TUV567WXY890ZAB123CDE',
            },
            ratePerSecond: {
              type: 'string',
              description: 'Payment rate per second (positive integer as string, i128)',
              example: '100',
            },
            depositedAmount: {
              type: 'string',
              description: 'Initial deposited amount (positive integer as string, i128)',
              example: '10000',
            },
            startTime: {
              oneOf: [{ type: 'integer' }, { type: 'string' }],
              description: 'Stream start time (Unix timestamp)',
              example: 1708531200,
            },
          },
        },
      },
    },
  },
  apis: ['./src/**/*.ts'], // Path to the API routes
};

/**
 * Deterministic OpenAPI document. Keys are sorted recursively so the artifact
 * written by `npm run openapi:export` is reproducible and CI can fail on any
 * undocumented route, schema, status-code or auth change.
 */
export const swaggerSpec = sortKeysDeep(swaggerJsdoc(options));
