export type TransactionStatus =
  | 'prepared'
  | 'revalidated'
  | 'submitted'
  | 'rejected';

export interface TransactionContext {
  /** Identifier of the active account (address or account id). */
  account: string;
  /** Active chain/network identifier, e.g. "mainnet" or a chain id. */
  network: string;
  /** Opaque fingerprint of the stream state the payload was prepared against. */
  streamState: string;
}

export interface PreparedTransaction<T = unknown> {
  id: string;
  payload: T;
  status: TransactionStatus;
  /** Context captured at preparation time. */
  context: TransactionContext;
  /** Epoch milliseconds after which the payload is considered expired. */
  expiresAt: number;
  /** Epoch milliseconds when the payload was prepared. */
  preparedAt: number;
  /** Epoch milliseconds when the payload was last revalidated. */
  revalidatedAt?: number;
  /** Epoch milliseconds when the payload was submitted. */
  submittedAt?: number;
  /** Reason the payload was rejected, if any. */
  rejectionReason?: string;
}

export type RevalidationFailure =
  | 'expired'
  | 'stale-stream-state'
  | 'network-mismatch'
  | 'account-changed'
  | 'already-submitted';

export type RevalidationResult<T = unknown> =
  | { ok: true; transaction: PreparedTransaction<T> }
  | { ok: false; reason: RevalidationFailure; message: string };

export interface PrepareOptions {
  /** Time-to-live for the prepared payload in milliseconds. */
  ttlMs?: number;
  /** Injectable clock for deterministic testing. */
  now?: () => number;
  /** Injectable id generator for deterministic testing. */
  generateId?: () => string;
}

export const DEFAULT_PREPARED_TTL_MS = 5 * 60 * 1000;

let fallbackCounter = 0;

function defaultGenerateId(): string {
  fallbackCounter += 1;
  return `tx-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

/**
 * Prepare a transaction payload for later submission. No wallet signature is
 * requested here; the payload must be revalidated before submission.
 */
export function prepareTransaction<T>(
  payload: T,
  context: TransactionContext,
  options: PrepareOptions = {},
): PreparedTransaction<T> {
  const now = options.now ?? Date.now;
  const generateId = options.generateId ?? defaultGenerateId;
  const ttlMs = options.ttlMs ?? DEFAULT_PREPARED_TTL_MS;
  const preparedAt = now();

  return {
    id: generateId(),
    payload,
    status: 'prepared',
    context: { ...context },
    preparedAt,
    expiresAt: preparedAt + ttlMs,
  };
}

/**
 * Revalidate a prepared transaction against current stream state, active
 * network/chain, account, and expiry. Returns a revalidated transaction on
 * success or a clear failure reason otherwise. Never mutates the input.
 */
export function revalidateTransaction<T>(
  transaction: PreparedTransaction<T>,
  current: TransactionContext,
  now: () => number = Date.now,
): RevalidationResult<T> {
  if (transaction.status === 'submitted') {
    return {
      ok: false,
      reason: 'already-submitted',
      message: 'Transaction has already been submitted.',
    };
  }

  if (transaction.status === 'rejected') {
    return {
      ok: false,
      reason: 'expired',
      message: transaction.rejectionReason ?? 'Transaction was rejected.',
    };
  }

  const currentTime = now();
  if (currentTime >= transaction.expiresAt) {
    return {
      ok: false,
      reason: 'expired',
      message: 'Prepared transaction has expired; please prepare it again.',
    };
  }

  if (current.account !== transaction.context.account) {
    return {
      ok: false,
      reason: 'account-changed',
      message: 'Active account changed since the transaction was prepared.',
    };
  }

  if (current.network !== transaction.context.network) {
    return {
      ok: false,
      reason: 'network-mismatch',
      message: 'Active network changed since the transaction was prepared.',
    };
  }

  if (current.streamState !== transaction.context.streamState) {
    return {
      ok: false,
      reason: 'stale-stream-state',
      message: 'Stream state changed since the transaction was prepared.',
    };
  }

  return {
    ok: true,
    transaction: {
      ...transaction,
      status: 'revalidated',
      revalidatedAt: currentTime,
    },
  };
}

/**
 * Mark a revalidated transaction as submitted. Rejects transactions that have
 * not passed revalidation or that were already submitted, preventing duplicate
 * submissions of the same prepared action.
 */
export function markSubmitted<T>(
  transaction: PreparedTransaction<T>,
  now: () => number = Date.now,
): RevalidationResult<T> {
  if (transaction.status === 'submitted') {
    return {
      ok: false,
      reason: 'already-submitted',
      message: 'Transaction has already been submitted.',
    };
  }

  if (transaction.status !== 'revalidated') {
    return {
      ok: false,
      reason: 'stale-stream-state',
      message: 'Transaction must be revalidated before submission.',
    };
  }

  return {
    ok: true,
    transaction: {
      ...transaction,
      status: 'submitted',
      submittedAt: now(),
    },
  };
}

/**
 * Invalidate a prepared transaction (e.g. on account or network change) so it
 * cannot be submitted without being prepared again.
 */
export function invalidateTransaction<T>(
  transaction: PreparedTransaction<T>,
  reason: string,
): PreparedTransaction<T> {
  return {
    ...transaction,
    status: 'rejected',
    rejectionReason: reason,
  };
}
