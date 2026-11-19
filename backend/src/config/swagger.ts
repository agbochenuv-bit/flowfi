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
  TooManyRequests: {
    description: 'Rate limit exceeded',
    content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
  },
  CostBudgetExceeded: {
    description:
      'Request exceeds the per-route complexity budget (HTTP 429, `error.code = COST_BUDGET_EXCEEDED`). ' +
      'The `Retry-After` header indicates when the budget window resets. Cheap requests are unaffected.',
    headers: {
      'Retry-After': {
        description: 'Seconds until the cost budget window resets',
        schema: { type: 'integer', example: 30 },
      },
      'X-Cost-Budget-Limit': {
        description: 'Cost units allowed for this route within the window',
        schema: { type: 'integer', example: 100 },
      },
      'X-Cost-Budget-Remaining': {
        description: 'Cost units remaining in the current window',
        schema: { type: 'integer', example: 0 },
      },
    },
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

## Exports (resumable, asynchronous)

Large activity and payment statements are generated as bounded background jobs so clients never
hold a long HTTP request open:

1. \`POST /v1/exports\` creates a job owned by the authenticated wallet.
2. \`GET /v1/exports/{jobId}\` polls status; clients resume from \`nextPage\` after a disconnect.
3. \`GET /v1/exports/{jobId}/download\` streams the artifact (or a single page) once \`completed\`.
4. \`DELETE /v1/exports/{jobId}\` cancels a non-terminal job.

Jobs are wallet-scoped (cross-wallet access returns \`404\`), expire after a bounded TTL, and are
computed against a single snapshot so multi-page downloads are consistent. See the
\`ExportJob\` and \`ExportColumn\` schemas for the full contract, including the UTC timestamp rule
and the amount/unit/decimals rule.

## Request cost budgets

Expensive read routes (analytics, exports, multi-resource queries) enforce a per-route
complexity budget in addition to request-count rate limits. When a request would exceed the
budget the API returns \`429\` with \`error.code = "COST_BUDGET_EXCEEDED"\`, a \`Retry-After\`
header, and a \`limit\` object describing the route, cost, limit and remaining units. Cheap
requests are unaffected.

## Error Envelope (v1)
=======

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
consumers are unaffected. Unknown codes should be treated as generic failures.`,
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
        name: 'Exports',
        description:
          'Resumable, asynchronous wallet activity and payment statement exports. ' +
          'Jobs are owned by the authenticated wallet, expire after a bounded TTL, can be cancelled, ' +
          'and downloads require the same wallet authorization as the creating request.',
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
        ExportJobStatus: {
          type: 'string',
          enum: ['queued', 'running', 'completed', 'failed', 'cancelled', 'expired'],
          description:
            'Lifecycle of an export job. Terminal states are `completed`, `failed`, `cancelled` and `expired`; ' +
            '`expired` is reached when the job outlives its TTL before completion.',
          example: 'running',
        },
        ExportFormat: {
          type: 'string',
          enum: ['csv', 'json'],
          description: 'Serialization of the export artifact. CSV uses the documented column schema.',
          example: 'csv',
        },
        ExportJob: {
          type: 'object',
          description: `A resumable asynchronous export job.

**Ownership:** a job is bound to the wallet that created it. Any request for the job
(status, download, cancel) from a different wallet returns \`404 NOT_FOUND\` so job existence
is not leaked.

**Expiry:** jobs expire after \`expiresAt\`. Expired jobs cannot be downloaded and are reported
with \`status = "expired"\`.

**Cancellation:** \`DELETE /v1/exports/{jobId}\` moves a non-terminal job to \`cancelled\`.
Cancelling a terminal job is idempotent.

**Snapshot consistency:** the export is computed against a single snapshot taken when the job
starts, so multi-page downloads never observe rows added or removed mid-export.`,
          required: ['jobId', 'wallet', 'status', 'format', 'createdAt', 'expiresAt'],
          properties: {
            jobId: { type: 'string', format: 'uuid', description: 'Stable identifier used to resume polling and download' },
            wallet: { type: 'string', description: 'Stellar public key that owns the job' },
            status: { $ref: '#/components/schemas/ExportJobStatus' },
            format: { $ref: '#/components/schemas/ExportFormat' },
            createdAt: { type: 'string', format: 'date-time', description: 'Job creation time (UTC)' },
            startedAt: { type: 'string', format: 'date-time', nullable: true, description: 'When processing began (UTC)' },
            completedAt: { type: 'string', format: 'date-time', nullable: true, description: 'When the job reached a terminal state (UTC)' },
            expiresAt: { type: 'string', format: 'date-time', description: 'After this instant the job can no longer be downloaded' },
            snapshotAt: {
              type: 'string',
              format: 'date-time',
              nullable: true,
              description: 'Instant the underlying data snapshot was taken; all pages of the export are consistent with it',
            },
            rowCount: { type: 'integer', nullable: true, description: 'Number of rows in the completed export' },
            pageCount: { type: 'integer', nullable: true, description: 'Number of pages in the completed export' },
            nextPage: {
              type: 'integer',
              nullable: true,
              description: 'Next page to fetch when resuming a partially downloaded export; null when complete',
            },
            downloadUrl: {
              type: 'string',
              nullable: true,
              description: 'Relative URL to download the artifact; only present while status is `completed` and the job has not expired',
              example: '/v1/exports/3f1c2b9e-8a4d-4c6e-9f2a-1b7d5e0c9a83/download',
            },
            error: {
              type: 'object',
              nullable: true,
              description: 'Present when status is `failed`',
              properties: {
                code: { type: 'string', example: 'EXPORT_FAILED' },
                message: { type: 'string', description: 'Safe failure summary; internal exception text is never exposed' },
              },
            },
          },
        },
        CreateExportRequest: {
          type: 'object',
          required: ['kind'],
          properties: {
            kind: {
              type: 'string',
              enum: ['activity', 'payments'],
              description: '`activity` exports stream lifecycle events; `payments` exports payment records',
              example: 'activity',
            },
            format: { $ref: '#/components/schemas/ExportFormat' },
            from: { type: 'string', format: 'date-time', description: 'Inclusive lower bound on event time (UTC)' },
            to: { type: 'string', format: 'date-time', description: 'Exclusive upper bound on event time (UTC)' },
            networkId: {
              type: 'string',
              description: 'Stellar network identifier the export is scoped to (e.g. `testnet`, `pubnet`)',
              example: 'testnet',
            },
          },
        },
        ExportColumn: {
          type: 'object',
          description: `Column schema for accounting-friendly exports. Every export carries explicit units,
network identifiers and transaction references so it can be reproduced and reconciled.

**Timezone rule:** all timestamps are emitted in UTC, ISO-8601 with a trailing \`Z\`
(e.g. \`2024-02-21T16:00:00Z\`). No local-time conversion is performed.

**Amount rule:** amounts are emitted as integer base units in a string field, with the token
decimals and unit recorded alongside so the value can be reconstructed exactly.`,
          required: ['timestamp', 'streamId', 'eventType', 'direction', 'amount', 'unit', 'decimals', 'networkId', 'txHash'],
          properties: {
            timestamp: { type: 'string', format: 'date-time', description: 'Event time in UTC (ISO-8601, trailing Z)' },
            streamId: { type: 'integer', description: 'On-chain stream ID' },
            eventType: {
              type: 'string',
              enum: ['CREATED', 'TOPPED_UP', 'WITHDRAWN', 'CANCELLED', 'COMPLETED', 'PAUSED', 'RESUMED', 'FEE_COLLECTED'],
              description: 'Stream lifecycle event type',
            },
            direction: {
              type: 'string',
              enum: ['in', 'out'],
              description: 'Whether the record credits (`in`) or debits (`out`) the exporting wallet',
            },
            amount: { type: 'string', description: 'Amount in integer base units (i128 as string)' },
            unit: { type: 'string', description: 'Token unit/symbol the amount is denominated in', example: 'USDC' },
            decimals: { type: 'integer', description: 'Number of decimals for the unit', example: 7 },
            networkId: { type: 'string', description: 'Stellar network identifier', example: 'testnet' },
            txHash: { type: 'string', description: 'Stellar transaction hash for the record' },
            ledgerSequence: { type: 'integer', description: 'Ledger sequence number' },
          },
        },
        ExportPage: {
          type: 'object',
          required: ['jobId', 'page', 'pageCount', 'rows'],
          properties: {
            jobId: { type: 'string', format: 'uuid' },
            page: { type: 'integer', description: 'Zero-based page index' },
            pageCount: { type: 'integer', description: 'Total number of pages in the export' },
            nextPage: { type: 'integer', nullable: true, description: 'Next page index, or null when this is the last page' },
            rows: {
              type: 'array',
              description: 'Rows for this page, each conforming to the export column schema',
              items: { $ref: '#/components/schemas/ExportColumn' },
            },
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
                    'COST_BUDGET_EXCEEDED',
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
                limit: {
                  type: 'object',
                  nullable: true,
                  description:
                    'Present when `code = COST_BUDGET_EXCEEDED`. Describes the per-route cost budget that was exceeded.',
                  properties: {
                    route: { type: 'string', description: 'Route whose cost budget was exceeded', example: 'GET /v1/exports' },
                    cost: { type: 'integer', description: 'Cost units the request would have consumed', example: 120 },
                    limit: { type: 'integer', description: 'Cost units allowed for this route within the window', example: 100 },
                    remaining: { type: 'integer', description: 'Cost units remaining in the current window', example: 0 },
                    retryAfterSeconds: { type: 'integer', description: 'Seconds until the budget window resets', example: 30 },
                  },
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
