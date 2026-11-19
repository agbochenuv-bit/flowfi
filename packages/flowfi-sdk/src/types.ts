/**
 * Shared SDK types for FlowFi Soroban transaction building.
 *
 * Amounts are expressed in stroops (i128) as `bigint` to avoid precision loss
 * beyond `Number.MAX_SAFE_INTEGER`. Stream IDs map to the contract's `u64`.
 */

export interface FlowFiClientConfig {
  /** Soroban RPC endpoint, e.g. `https://soroban-testnet.stellar.org`. */
  rpcUrl: string;
  /** Network passphrase, e.g. `Test SDF Network ; September 2015`. */
  networkPassphrase: string;
  /** Deployed `stream_contract` contract ID (C... address). */
  contractId: string;
  /** Optional funded account used as the transaction source for read simulations. */
  readOnlySourceAccount?: string;
  /**
   * Safety multiplier applied on top of the simulated resource fee.
   * `1.2` means "charge 20% more than simulation". Defaults to `1.25`.
   */
  feeBufferMultiplier?: number;
  /**
   * Opt out of the official network-passphrase check. Set to `true` only for
   * intentional custom/private Stellar networks. Defaults to `false`, in which
   * case an unrecognised passphrase throws from the `FlowFiClient` constructor
   * with a hint listing the official passphrases.
   */
  allowCustomNetworkPassphrase?: boolean;
}

export interface CreateStreamParams {
  sender: string;
  recipient: string;
  tokenAddress: string;
  /** Gross amount in stroops. Must be > 0. */
  amount: bigint;
  /** Stream duration in seconds. Must be > 0. */
  duration: number;
  /** Optional vesting cliff in seconds (0 < cliff <= duration). */
  cliffDuration?: number;
}

/**
 * Lifecycle status of a payment stream, mirroring the contract's
 * `StreamStatus` enum (Active, Paused, Cancelled, Completed).
 */
export type StreamStatus = 'Active' | 'Paused' | 'Cancelled' | 'Completed';

/**
 * How a stream's tokens unlock over time, mirroring the contract's
 * `VestingSchedule` enum:
 * - `linear` — continuous drip at the stream's rate per second.
 * - `step_tranches` — milestone tranches, each unlocking a fixed amount at an
 *   absolute timestamp.
 * - `hybrid_cliff_linear` — a lump-sum cliff unlock followed by a linear drip.
 */
export type VestingSchedule =
  | { kind: 'linear' }
  | { kind: 'step_tranches'; steps: VestingStep[] }
  | { kind: 'hybrid_cliff_linear'; cliffTime: bigint; cliffUnlockAmount: bigint };

/**
 * A single discrete unlock of a step-tranche (milestone) vesting schedule.
 */
export interface VestingStep {
  /** Absolute ledger timestamp (Unix epoch seconds) at which the tranche unlocks. */
  unlockTime: number | bigint;
  /** Amount unlocked at `unlockTime`, in stroops. */
  unlockAmount: bigint | number;
}

export interface StreamDetails {
  streamId: bigint;
  sender: string;
  recipient: string;
  tokenAddress: string;
  ratePerSecond: bigint;
  depositedAmount: bigint;
  withdrawnAmount: bigint;
  startTime: bigint;
  lastUpdateTime: bigint;
  cliffTime?: bigint | null;
  isActive: boolean;
  paused: boolean;
  status: StreamStatus;
  /** Unlock curve for the stream, when the data source provides it. */
  schedule?: VestingSchedule;
}

// ─── Runtime type guards ──────────────────────────────────────────────────────

const STREAM_STATUSES: readonly StreamStatus[] = ['Active', 'Paused', 'Cancelled', 'Completed'];

/**
 * Runtime type guard narrowing `unknown` to `StreamStatus`.
 *
 * Data decoded from RPC/JSON (e.g. via the Soroban RPC `scValToNative` or a
 * backend response) arrives untyped; this guard validates the string against
 * the contract's `StreamStatus` variants before callers rely on it.
 *
 * @param value - Value to validate.
 * @returns `true` when `value` is one of `'Active' | 'Paused' | 'Cancelled' | 'Completed'`.
 *
 * @example
 * ```ts
 * if (isStreamStatus(raw.status)) {
 *   // raw.status is narrowed to StreamStatus
 * }
 * ```
 */
export function isStreamStatus(value: unknown): value is StreamStatus {
  return (
    typeof value === 'string' && (STREAM_STATUSES as readonly string[]).includes(value)
  );
}

function isVestingStep(value: unknown): value is VestingStep {
  if (typeof value !== 'object' || value === null) return false;
  const step = value as Record<string, unknown>;
  return (
    (typeof step.unlockTime === 'number' || typeof step.unlockTime === 'bigint') &&
    (typeof step.unlockAmount === 'number' || typeof step.unlockAmount === 'bigint')
  );
}

/**
 * Runtime type guard narrowing `unknown` to `VestingSchedule`.
 *
 * Accepts the discriminated-union JSON shape produced by the backend indexer
 * (`{ kind: 'linear' | 'step_tranches' | 'hybrid_cliff_linear', ... }`) and
 * validates each variant's payload: step times/amounts for `step_tranches`,
 * numeric cliff fields for `hybrid_cliff_linear`.
 *
 * @param value - Value to validate.
 * @returns `true` when `value` is a well-formed {@link VestingSchedule}.
 *
 * @example
 * ```ts
 * if (isVestingSchedule(raw.schedule)) {
 *   // raw.schedule is narrowed to VestingSchedule
 * }
 * ```
 */
export function isVestingSchedule(value: unknown): value is VestingSchedule {
  if (typeof value !== 'object' || value === null) return false;
  const schedule = value as Record<string, unknown>;

  switch (schedule.kind) {
    case 'linear':
      return true;
    case 'step_tranches':
      return (
        Array.isArray(schedule.steps) && schedule.steps.every(isVestingStep)
      );
    case 'hybrid_cliff_linear':
      return (
        (typeof schedule.cliffTime === 'number' || typeof schedule.cliffTime === 'bigint') &&
        (typeof schedule.cliffUnlockAmount === 'number' ||
          typeof schedule.cliffUnlockAmount === 'bigint')
      );
    default:
      return false;
  }
}

export interface StreamResult {
  streamId: bigint;
  transactionHash: string;
}

export interface WithdrawResult {
  streamId: bigint;
  amount: bigint;
  transactionHash: string;
}

export interface SubmitResult {
  transactionHash: string;
}

// ─── Optimistic concurrency (stale mutation conflicts) ────────────────────────

/**
 * Stable machine-readable code returned when a mutation is rejected because
 * the stream changed after the client reviewed it.
 */
export const STREAM_VERSION_CONFLICT_CODE = 'STREAM_VERSION_CONFLICT' as const;

/**
 * Version metadata describing the stream state a client reviewed.
 *
 * `version` is an opaque, monotonically increasing token (the contract's
 * `last_update_time` ledger timestamp). Clients must echo the value they
 * reviewed back on mutations; the API rejects the mutation with
 * {@link StreamVersionConflict} when the stream has advanced since.
 */
export interface StreamVersion {
  streamId: bigint;
  /** Opaque version token the client reviewed. */
  version: bigint;
  /** Ledger timestamp of the last mutation, when known. */
  lastUpdateTime?: bigint | null;
}

/**
 * Conflict response body returned with HTTP 409 when a mutation is stale.
 *
 * Wallet-signed transaction semantics are unchanged: the client must rebuild
 * and re-sign the transaction against the current version. The API never
 * signs on the client's behalf.
 */
export interface StreamVersionConflict {
  code: typeof STREAM_VERSION_CONFLICT_CODE;
  message: string;
  /** Version the client submitted (may be absent if omitted). */
  expectedVersion?: bigint | null;
  /** Current version metadata the client should re-review. */
  current: StreamVersion;
}

// ─── Token metadata provenance ────────────────────────────────────────────────

/**
 * Trust level of token display metadata.
 *
 * - `verified` — sourced from the token contract itself (name/symbol/decimals
 *   read on-chain) and cross-checked against the configured allowlist.
 * - `on_chain` — read from the token contract but not cross-checked.
 * - `hint` — supplied by an untrusted source (client, indexer cache, config).
 * - `unavailable` — no metadata could be resolved; clients must fall back.
 */
export type TokenMetadataTrustLevel = 'verified' | 'on_chain' | 'hint' | 'unavailable';

/**
 * Freshness of token metadata relative to the time it was resolved.
 */
export type TokenMetadataFreshness = 'fresh' | 'stale' | 'unknown';

/**
 * Token display metadata with provenance.
 *
 * Raw on-chain amounts are never altered by this metadata: `decimals` is a
 * display hint only and must not be used to rescale stored stroop amounts
 * without an explicit conversion step.
 */
export interface TokenMetadata {
  tokenAddress: string;
  /** Token name, when resolved. */
  name?: string | null;
  /** Token symbol, when resolved. */
  symbol?: string | null;
  /** Display decimals hint; never changes raw on-chain amounts. */
  decimals?: number | null;
  trustLevel: TokenMetadataTrustLevel;
  freshness: TokenMetadataFreshness;
  /** Source identifier, e.g. `token_contract`, `indexer_cache`, `client_hint`. */
  source?: string | null;
  /** Unix epoch seconds when the metadata was resolved. */
  resolvedAt?: number | null;
  /** Unix epoch seconds after which the metadata should be considered stale. */
  staleAfter?: number | null;
  /** Human-readable reason when `trustLevel` is `unavailable` or `freshness` is `stale`. */
  reason?: string | null;
}

// ─── Action readiness (preflight) ─────────────────────────────────────────────

/**
 * Stable result codes for preflight readiness checks.
 *
 * These describe preflight observations only; they never promise that a
 * transaction will succeed on-chain.
 */
export type ReadinessCode =
  | 'OK'
  | 'WALLET_NOT_CONNECTED'
  | 'WALLET_NOT_AUTHORIZED'
  | 'NETWORK_MISMATCH'
  | 'CONTRACT_NOT_FOUND'
  | 'STREAM_NOT_FOUND'
  | 'STREAM_NOT_ACTIVE'
  | 'STREAM_PAUSED'
  | 'STREAM_COMPLETED'
  | 'STREAM_CANCELLED'
  | 'INSUFFICIENT_BALANCE'
  | 'INSUFFICIENT_ALLOWANCE'
  | 'TOKEN_METADATA_UNAVAILABLE'
  | 'STALE_STREAM_VERSION'
  | 'NOTHING_TO_WITHDRAW'
  | 'UNKNOWN';

/**
 * Severity of a readiness check result.
 *
 * - `blocker` — the action is expected to fail; clients should disable it.
 * - `warning` — the action may still succeed; clients should surface it.
 * - `info` — informational only.
 */
export type ReadinessSeverity = 'blocker' | 'warning' | 'info';

/**
 * A single preflight readiness check result.
 */
export interface ReadinessCheck {
  code: ReadinessCode;
  severity: ReadinessSeverity;
  message: string;
  /** Optional structured details, e.g. expected vs. actual network. */
  details?: Record<string, unknown>;
}

/**
 * Preflight readiness for a stream action.
 *
 * `ready` is `true` only when no check has `severity: 'blocker'`. It is a
 * preflight signal, not a guarantee of transaction success: state can change
 * between preflight and submission (see `checkedAt`).
 */
export interface ActionReadiness {
  action: 'create' | 'withdraw' | 'cancel' | 'pause' | 'resume';
  streamId?: bigint | null;
  ready: boolean;
  checks: ReadinessCheck[];
  /** Version metadata observed during preflight, when applicable. */
  version?: StreamVersion | null;
  /** Unix epoch seconds when the preflight was evaluated. */
  checkedAt: number;
}

// ─── Wallet sessions ──────────────────────────────────────────────────────────

/**
 * A wallet-authenticated session, as listed in the session inventory.
 *
 * Session records never contain signing secrets; only an opaque identifier and
 * descriptive metadata are exposed.
 */
export interface WalletSession {
  /** Opaque session identifier used for revocation. */
  sessionId: string;
  /** Stellar account (G... address) the session is authenticated for. */
  walletAddress: string;
  /** Unix epoch seconds when the session was created. */
  createdAt: number;
  /** Unix epoch seconds when the session was last used. */
  lastUsedAt?: number | null;
  /** Unix epoch seconds when the session expires. */
  expiresAt: number;
  /** Best-effort client description, e.g. user agent or device label. */
  deviceLabel?: string | null;
  /** Whether this session is the one making the current request. */
  current?: boolean;
}

export interface WalletSessionListResponse {
  sessions: WalletSession[];
}

export interface RevokeWalletSessionResponse {
  sessionId: string;
  /** `true` when the session was active and has now been revoked. */
  revoked: boolean;
  /** Unix epoch seconds when the revocation took effect. */
  revokedAt: number;
}
