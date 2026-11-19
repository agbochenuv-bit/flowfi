/**
 * Application type aliases derived from the auto-generated OpenAPI types.
 *
 * The generated file (`api-types.generated.ts`) is produced by running:
 *   npm run codegen:api-types  (in frontend/)
 * which calls openapi-typescript against the backend OpenAPI spec and writes
 * the result to src/lib/api-types.generated.ts.
 *
 * Rather than hand-writing types, we derive them here from
 * `components["schemas"]` in the generated file. This means any drift between
 * the backend spec and these types will be caught by the TypeScript compiler.
 *
 * For types that are not yet in the generated spec, a TODO comment is added.
 */
import type { components } from "@/lib/api-types.generated";

// ---------------------------------------------------------------------------
// User
// ---------------------------------------------------------------------------

/**
 * User as returned by the backend API (/v1/users endpoints).
 * Derived from components["schemas"]["User"].
 * The generated schema marks createdAt/updatedAt optional; we keep them
 * required here to preserve backwards-compatibility with existing call sites.
 */
export type BackendUser = Required<Pick<components["schemas"]["User"], "id" | "publicKey">> &
  Pick<components["schemas"]["User"], "createdAt" | "updatedAt">;

// ---------------------------------------------------------------------------
// Stream events
// ---------------------------------------------------------------------------

/**
 * The union of all known stream event type strings.
 *
 * The generated spec defines 8 event types. FEE_CONFIG_UPDATED and
 * ADMIN_TRANSFERRED are emitted by the contract but not yet documented in the
 * OpenAPI spec.
 * TODO: add FEE_CONFIG_UPDATED and ADMIN_TRANSFERRED to the backend OpenAPI spec,
 * then replace this hand-written union with:
 *   export type StreamEventType = components["schemas"]["StreamEvent"]["eventType"];
 */
export type StreamEventType =
  | components["schemas"]["StreamEvent"]["eventType"]
  | "FEE_CONFIG_UPDATED"
  | "ADMIN_TRANSFERRED";

/**
 * A single stream event as returned by the backend API.
 * Derived from components["schemas"]["StreamEvent"].
 *
 * Notes on differences from the generated schema:
 * - `amount` is `string | null` here (was already optional+null in spec).
 * - `createdAt` is kept required (spec marks it optional).
 * - `eventType` is widened to `StreamEventType` to include the two extra
 *   event types not yet in the spec (FEE_CONFIG_UPDATED, ADMIN_TRANSFERRED).
 */
export interface BackendStreamEvent
  extends Omit<components["schemas"]["StreamEvent"], "eventType" | "amount" | "createdAt"> {
  eventType: StreamEventType;
  amount: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Stream
// ---------------------------------------------------------------------------

/**
 * A payment stream record as returned by the backend API.
 * Derived from components["schemas"]["Stream"].
 *
 * Notes on differences from the generated schema:
 * - Several fields the spec marks optional are kept required here because
 *   the application logic relies on them always being present in responses.
 *   TODO: align the spec to mark these required, then simplify this type.
 * - `senderUser` / `recipientUser` and `events` are not yet in the spec.
 *   TODO: add them to the OpenAPI spec.
 */
export interface BackendStream
  extends Omit<
    components["schemas"]["Stream"],
    | "depositedAmount"
    | "withdrawnAmount"
    | "startTime"
    | "lastUpdateTime"
    | "isActive"
    | "isPaused"
    | "createdAt"
    | "updatedAt"
  > {
  // Fields that the spec marks optional but the app requires:
  depositedAmount: string;
  withdrawnAmount: string;
  startTime: number;
  lastUpdateTime: number;
  isActive: boolean;
  isPaused?: boolean;
  createdAt: string;
  updatedAt: string;
  // TODO: add senderUser, recipientUser, and events to the OpenAPI spec.
  senderUser?: BackendUser;
  recipientUser?: BackendUser;
  events?: BackendStreamEvent[];
}

// ---------------------------------------------------------------------------
// Operation-specific response types (derived from `paths`)
// ---------------------------------------------------------------------------

// Re-export generated component schemas for consumers that want direct access.
export type { components } from "@/lib/api-types.generated";

// ---------------------------------------------------------------------------
// Conflict responses (stale stream mutations)
// ---------------------------------------------------------------------------

/**
 * Machine-readable reason codes for a 409 conflict on a stream mutation.
 * Stable strings; clients should switch on these rather than on messages.
 */
export type StreamConflictReason =
  | "STALE_VERSION"
  | "CONCURRENT_UPDATE"
  | "VERSION_REQUIRED"
  | "STREAM_STATE_CHANGED";

/**
 * Payload returned with HTTP 409 when a mutation is rejected because the
 * stream changed since the client reviewed it.
 *
 * Derived from components["schemas"]["StreamConflictResponse"].
 * TODO: add StreamConflictResponse to the backend OpenAPI spec, then replace
 * this hand-written interface with the generated schema.
 */
export interface StreamConflictResponse {
  /** Stable conflict code. */
  code: "CONFLICT";
  /** Machine-readable reason for the conflict. */
  reason: StreamConflictReason;
  /** Human-readable explanation (not for programmatic use). */
  message: string;
  /** Stream the mutation targeted. */
  streamId: string;
  /** Version the client submitted (null if omitted). */
  submittedVersion: number | null;
  /** Current version of the stream at the time of rejection. */
  currentVersion: number;
  /** Current stream state snapshot so clients can re-render and retry. */
  currentStream?: BackendStream;
  /** Whether the client may retry the same mutation after refreshing. */
  retryable: boolean;
}

// ---------------------------------------------------------------------------
// Token metadata provenance / staleness
// ---------------------------------------------------------------------------

/**
 * Trust level for token metadata returned by the API.
 * - `verified`: metadata confirmed against an authoritative source.
 * - `onchain`: read directly from the token contract.
 * - `cached`: previously verified value served from cache.
 * - `hint`: unverified hint (e.g. user-supplied or heuristic); display only.
 * - `unknown`: no metadata available; clients must fall back to raw values.
 */
export type TokenMetadataTrustLevel =
  | "verified"
  | "onchain"
  | "cached"
  | "hint"
  | "unknown";

/**
 * Provenance and freshness information for token display metadata.
 *
 * Derived from components["schemas"]["TokenMetadataProvenance"].
 * TODO: add TokenMetadataProvenance to the backend OpenAPI spec.
 */
export interface TokenMetadataProvenance {
  /** Trust level of the accompanying metadata. */
  trustLevel: TokenMetadataTrustLevel;
  /** Source that produced the metadata (e.g. "contract", "registry", "cache"). */
  source: string;
  /** ISO-8601 timestamp when the metadata was last verified/refreshed. */
  fetchedAt: string | null;
  /** Age of the metadata in seconds, if known. */
  ageSeconds: number | null;
  /** Whether the metadata is considered stale and should be refreshed. */
  stale: boolean;
  /** Whether the metadata failed validation (malformed source response). */
  malformed: boolean;
}

/**
 * Token display metadata with provenance.
 * Raw on-chain amounts are never altered by these fields; they are display
 * hints only.
 *
 * Derived from components["schemas"]["TokenMetadata"].
 * TODO: add TokenMetadata to the backend OpenAPI spec.
 */
export interface TokenMetadata {
  /** Token contract/mint address. */
  address: string;
  /** Chain/network the token belongs to. */
  network: string;
  /** Display name, if available. */
  name: string | null;
  /** Display symbol, if available. */
  symbol: string | null;
  /** Number of decimals, if available. */
  decimals: number | null;
  /** Optional logo URI. */
  logoUri: string | null;
  /** Provenance and freshness of the fields above. */
  provenance: TokenMetadataProvenance;
}

// ---------------------------------------------------------------------------
// Action readiness checks
// ---------------------------------------------------------------------------

/**
 * Stable result codes for action readiness checks.
 */
export type ReadinessCode =
  | "OK"
  | "WALLET_NOT_CONNECTED"
  | "WRONG_NETWORK"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_ALLOWANCE"
  | "STREAM_NOT_ACTIVE"
  | "STREAM_PAUSED"
  | "NOT_AUTHORIZED"
  | "STALE_STATE"
  | "ASSET_UNSUPPORTED"
  | "ASSET_METADATA_UNAVAILABLE"
  | "UNKNOWN";

/**
 * Severity of a readiness check result.
 * - `blocker`: the action will fail if attempted.
 * - `warning`: the action may succeed but the client should confirm.
 * - `info`: informational only.
 */
export type ReadinessSeverity = "blocker" | "warning" | "info";

/**
 * A single preflight check result for a stream action.
 *
 * Derived from components["schemas"]["ReadinessCheck"].
 * TODO: add ReadinessCheck to the backend OpenAPI spec.
 */
export interface ReadinessCheck {
  /** Stable check identifier (e.g. "authorization", "network"). */
  id: string;
  /** Stable result code. */
  code: ReadinessCode;
  /** Whether this result blocks the action or is advisory. */
  severity: ReadinessSeverity;
  /** Human-readable message (not for programmatic use). */
  message: string;
  /** Optional structured details for the check. */
  details?: Record<string, unknown> | null;
}

/**
 * Preflight readiness for a stream action.
 * This does not promise transaction success; it reflects checks at the time
 * of the request and may be invalidated by concurrent changes.
 *
 * Derived from components["schemas"]["ActionReadiness"].
 * TODO: add ActionReadiness to the backend OpenAPI spec.
 */
export interface ActionReadiness {
  /** Action the readiness applies to (e.g. "withdraw", "cancel"). */
  action: string;
  streamId: string;
  /** Whether all blockers passed (warnings do not block). */
  ready: boolean;
  /** Checks that will cause the action to fail. */
  blockers: ReadinessCheck[];
  /** Advisory checks that do not block the action. */
  warnings: ReadinessCheck[];
  /** Informational checks. */
  info: ReadinessCheck[];
  /** Version of the stream state these checks were evaluated against. */
  evaluatedVersion: number | null;
  /** ISO-8601 timestamp when the checks were evaluated. */
  evaluatedAt: string;
}

// ---------------------------------------------------------------------------
// Wallet sessions
// ---------------------------------------------------------------------------

/**
 * A wallet-authenticated session as returned by the session inventory.
 * Contains no signing secrets.
 *
 * Derived from components["schemas"]["WalletSession"].
 * TODO: add WalletSession to the backend OpenAPI spec.
 */
export interface WalletSession {
  /** Opaque session identifier (safe to display). */
  id: string;
  /** Wallet public key the session is bound to. */
  publicKey: string;
  /** ISO-8601 creation timestamp. */
  createdAt: string;
  /** ISO-8601 timestamp of last activity. */
  lastActiveAt: string | null;
  /** ISO-8601 expiry timestamp. */
  expiresAt: string;
  /** Whether the session has been revoked. */
  revoked: boolean;
  /** ISO-8601 revocation timestamp, if revoked. */
  revokedAt: string | null;
  /** Best-effort client description (user agent / device label). */
  userAgent: string | null;
  /** Best-effort IP address, if recorded. */
  ipAddress: string | null;
  /** Whether this session is the one making the current request. */
  current: boolean;
}

/**
 * Response for the session inventory endpoint.
 *
 * Derived from components["schemas"]["WalletSessionListResponse"].
 * TODO: add WalletSessionListResponse to the backend OpenAPI spec.
 */
export interface WalletSessionListResponse {
  sessions: WalletSession[];
}

/**
 * Response for session revocation.
 *
 * Derived from components["schemas"]["WalletSessionRevocationResponse"].
 * TODO: add WalletSessionRevocationResponse to the backend OpenAPI spec.
 */
export interface WalletSessionRevocationResponse {
  /** Session that was revoked. */
  sessionId: string;
  /** Whether the session is now revoked (idempotent). */
  revoked: boolean;
  /** ISO-8601 timestamp of revocation. */
  revokedAt: string | null;
}
