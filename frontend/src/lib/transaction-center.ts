/**
 * Transaction Center
 *
 * Centralizes submitted, confirming, failed, and user-action-required
 * transactions so users can safely resume or inspect them.
 *
 * Persistence policy (see docs/transaction-center.md):
 *   - Only NON-SECRET recovery metadata is written to localStorage:
 *       id, idempotencyKey, hash, actionType, streamId, networkPassphrase,
 *       status, timestamps, errorCode.
 *   - Signed envelopes, secret keys, and wallet session data are NEVER
 *     persisted. They must be supplied again by the wallet on resume.
 */

export type TransactionStatus =
  | "submitted"
  | "confirming"
  | "confirmed"
  | "failed"
  | "user_action_required";

export type TransactionActionType =
  | "create_stream"
  | "withdraw"
  | "cancel_stream"
  | "top_up"
  | "claim"
  | "other";

/**
 * Non-secret recovery metadata. This is the ONLY shape that is persisted.
 */
export interface TransactionRecoveryMetadata {
  /** Client-generated unique id for this transaction record. */
  id: string;
  /**
   * Client-generated idempotency key. Used to prevent duplicate submissions
   * of the same logical action (e.g. double-click, retry after reload).
   */
  idempotencyKey: string;
  /** On-chain transaction hash, once known. */
  hash: string | null;
  /** The kind of action this transaction performs. */
  actionType: TransactionActionType;
  /** Related stream id, when applicable. */
  streamId: string | null;
  /** Stellar network passphrase the transaction was submitted to. */
  networkPassphrase: string;
  /** Current lifecycle status. */
  status: TransactionStatus;
  /** ISO timestamp when the record was created. */
  createdAt: string;
  /** ISO timestamp of the last status change. */
  updatedAt: string;
  /** ISO timestamp when the transaction reached a final state, if any. */
  finalizedAt: string | null;
  /** Machine-readable error code for failed / user_action_required states. */
  errorCode: string | null;
}

/**
 * In-memory record. Extends recovery metadata with transient, non-persisted
 * fields that are only valid for the current session.
 */
export interface TransactionRecord extends TransactionRecoveryMetadata {
  /** Human-readable message for the current state (not persisted). */
  message: string | null;
}

export interface SubmitTransactionInput {
  actionType: TransactionActionType;
  networkPassphrase: string;
  streamId?: string | null;
  /**
   * Optional caller-supplied idempotency key. If omitted, one is generated.
   * Callers should supply a deterministic key when they can, so that a
   * reload + retry maps onto the same logical action.
   */
  idempotencyKey?: string;
  /** Optional pre-known hash (e.g. when resuming from a wallet flow). */
  hash?: string | null;
}

export interface UpdateStatusInput {
  status: TransactionStatus;
  hash?: string | null;
  errorCode?: string | null;
  message?: string | null;
}

export interface ResumeTransactionResult {
  /**
   * The recovery metadata needed to re-drive the action through the wallet.
   * Contains no secrets; the caller must re-authorize via the wallet.
   */
  metadata: TransactionRecoveryMetadata;
}

export type TransactionCenterListener = (records: TransactionRecord[]) => void;

const STORAGE_KEY = "lumentrade.transaction-center.v1";

const FINAL_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  "confirmed",
  "failed",
]);

const VALID_STATUSES: ReadonlySet<TransactionStatus> = new Set([
  "submitted",
  "confirming",
  "confirmed",
  "failed",
  "user_action_required",
]);

const VALID_ACTION_TYPES: ReadonlySet<TransactionActionType> = new Set([
  "create_stream",
  "withdraw",
  "cancel_stream",
  "top_up",
  "claim",
  "other",
]);

/** Allowed status transitions. Prevents illegal finality regressions. */
const ALLOWED_TRANSITIONS: Record<TransactionStatus, TransactionStatus[]> = {
  submitted: ["confirming", "confirmed", "failed", "user_action_required"],
  confirming: ["confirmed", "failed", "user_action_required"],
  user_action_required: ["submitted", "confirming", "confirmed", "failed"],
  // Final states are terminal.
  confirmed: [],
  failed: [],
};

function nowIso(): string {
  return new Date().toISOString();
}

function generateId(): string {
  const cryptoObj: Crypto | undefined =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return cryptoObj.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID.
  return `tx_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

function generateIdempotencyKey(): string {
  const cryptoObj: Crypto | undefined =
    typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return `idem_${cryptoObj.randomUUID()}`;
  }
  return `idem_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 12)}`;
}

function isFinal(status: TransactionStatus): boolean {
  return FINAL_STATUSES.has(status);
}

function canTransition(from: TransactionStatus, to: TransactionStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Validate and normalize a persisted record. Returns null if the record is
 * malformed or contains unexpected (potentially secret) fields.
 */
function sanitizePersistedRecord(raw: unknown): TransactionRecoveryMetadata | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const id = typeof r.id === "string" ? r.id : null;
  const idempotencyKey =
    typeof r.idempotencyKey === "string" ? r.idempotencyKey : null;
  const actionType = r.actionType as TransactionActionType;
  const status = r.status as TransactionStatus;
  const networkPassphrase =
    typeof r.networkPassphrase === "string" ? r.networkPassphrase : null;
  const createdAt = typeof r.createdAt === "string" ? r.createdAt : null;
  const updatedAt = typeof r.updatedAt === "string" ? r.updatedAt : null;

  if (
    !id ||
    !idempotencyKey ||
    !networkPassphrase ||
    !createdAt ||
    !updatedAt ||
    !VALID_ACTION_TYPES.has(actionType) ||
    !VALID_STATUSES.has(status)
  ) {
    return null;
  }

  return {
    id,
    idempotencyKey,
    hash: typeof r.hash === "string" ? r.hash : null,
    actionType,
    streamId: typeof r.streamId === "string" ? r.streamId : null,
    networkPassphrase,
    status,
    createdAt,
    updatedAt,
    finalizedAt: typeof r.finalizedAt === "string" ? r.finalizedAt : null,
    errorCode: typeof r.errorCode === "string" ? r.errorCode : null,
  };
}

function toRecord(meta: TransactionRecoveryMetadata): TransactionRecord {
  return { ...meta, message: null };
}

function toRecoveryMetadata(record: TransactionRecord): TransactionRecoveryMetadata {
  // Explicitly whitelist fields so transient/secret data can never leak.
  return {
    id: record.id,
    idempotencyKey: record.idempotencyKey,
    hash: record.hash,
    actionType: record.actionType,
    streamId: record.streamId,
    networkPassphrase: record.networkPassphrase,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    finalizedAt: record.finalizedAt,
    errorCode: record.errorCode,
  };
}

function getStorage(): Storage | null {
  try {
    if (typeof globalThis === "undefined") return null;
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage ?? null;
  } catch {
    // Accessing localStorage can throw (e.g. disabled cookies / SSR).
    return null;
  }
}

class TransactionCenter {
  private records: Map<string, TransactionRecord> = new Map();
  private listeners: Set<TransactionCenterListener> = new Set();
  private loaded = false;

  // ---------------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------------

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    this.loadFromStorage();
  }

  private loadFromStorage(): void {
    const storage = getStorage();
    if (!storage) return;

    let parsed: unknown;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (!raw) return;
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt payload: drop it rather than crash the app.
      try {
        storage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
      return;
    }

    if (!Array.isArray(parsed)) return;

    for (const item of parsed) {
      const meta = sanitizePersistedRecord(item);
      if (!meta) continue;
      // Keep the most recently updated record if ids collide.
      const existing = this.records.get(meta.id);
      if (!existing || existing.updatedAt < meta.updatedAt) {
        this.records.set(meta.id, toRecord(meta));
      }
    }
  }

  private persist(): void {
    const storage = getStorage();
    if (!storage) return;

    const payload = Array.from(this.records.values()).map(toRecoveryMetadata);
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Quota exceeded or storage disabled: keep in-memory state intact.
    }
  }

  // ---------------------------------------------------------------------------
  // Subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to transaction list changes. Returns an unsubscribe function.
   * The listener is invoked immediately with the current snapshot.
   */
  subscribe(listener: TransactionCenterListener): () => void {
    this.ensureLoaded();
    this.listeners.add(listener);
    listener(this.listTransactions());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.listTransactions();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A faulty listener must not break others.
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Queries
  // ---------------------------------------------------------------------------

  /**
   * List transactions, newest first. By default includes all statuses;
   * pass `{ includeFinal: false }` to only see actionable ones.
   */
  listTransactions(options?: { includeFinal?: boolean }): TransactionRecord[] {
    this.ensureLoaded();
    const includeFinal = options?.includeFinal ?? true;
    const all = Array.from(this.records.values())
      .filter((r) => includeFinal || !isFinal(r.status))
      .map((r) => ({ ...r }));
    all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    return all;
  }

  getTransaction(id: string): TransactionRecord | null {
    this.ensureLoaded();
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  /**
   * Returns true if a non-final transaction already exists for the given
   * idempotency key. Used to prevent duplicate submissions.
   */
  hasPendingDuplicate(idempotencyKey: string): boolean {
    this.ensureLoaded();
    if (!idempotencyKey) return false;
    for (const record of this.records.values()) {
      if (record.idempotencyKey === idempotencyKey && !isFinal(record.status)) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Mutations
  // ---------------------------------------------------------------------------

  /**
   * Record a newly submitted transaction.
   *
   * Throws if a non-final transaction already exists for the same
   * idempotency key, preventing duplicate submissions.
   */
  submitTransaction(input: SubmitTransactionInput): TransactionRecord {
    this.ensureLoaded();

    if (!input.networkPassphrase) {
      throw new Error("networkPassphrase is required");
    }
    if (!VALID_ACTION_TYPES.has(input.actionType)) {
      throw new Error(`Unsupported actionType: ${String(input.actionType)}`);
    }

    const idempotencyKey = input.idempotencyKey ?? generateIdempotencyKey();

    if (this.hasPendingDuplicate(idempotencyKey)) {
      throw new Error(
        `Duplicate submission: a pending transaction already exists for idempotency key ${idempotencyKey}`,
      );
    }

    const timestamp = nowIso();
    const record: TransactionRecord = {
      id: generateId(),
      idempotencyKey,
      hash: input.hash ?? null,
      actionType: input.actionType,
      streamId: input.streamId ?? null,
      networkPassphrase: input.networkPassphrase,
      status: "submitted",
      createdAt: timestamp,
      updatedAt: timestamp,
      finalizedAt: null,
      errorCode: null,
      message: null,
    };

    this.records.set(record.id, record);
    this.persist();
    this.emit();
    return { ...record };
  }

  /**
   * Update the status of an existing transaction. Enforces legal transitions
   * and stamps `finalizedAt` when reaching a final state.
   *
   * Throws if the transaction does not exist or the transition is illegal.
   */
  updateStatus(id: string, update: UpdateStatusInput): TransactionRecord {
    this.ensureLoaded();

    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Unknown transaction: ${id}`);
    }
    if (!VALID_STATUSES.has(update.status)) {
      throw new Error(`Invalid status: ${String(update.status)}`);
    }
    if (!canTransition(record.status, update.status)) {
      throw new Error(
        `Illegal transition for transaction ${id}: ${record.status} -> ${update.status}`,
      );
    }

    const timestamp = nowIso();
    record.status = update.status;
    record.updatedAt = timestamp;

    if (update.hash !== undefined) {
      record.hash = update.hash;
    }
    if (update.errorCode !== undefined) {
      record.errorCode = update.errorCode;
    }
    if (update.message !== undefined) {
      record.message = update.message;
    }

    if (isFinal(update.status)) {
      record.finalizedAt = timestamp;
    } else {
      record.finalizedAt = null;
    }

    this.records.set(id, record);
    this.persist();
    this.emit();
    return { ...record };
  }

  /**
   * Prepare a transaction for resumption. Returns the non-secret recovery
   * metadata; the caller must re-authorize through the wallet and then call
   * `updateStatus` as the flow progresses.
   *
   * Throws if the transaction is unknown or already final.
   */
  resumeTransaction(id: string): ResumeTransactionResult {
    this.ensureLoaded();

    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Unknown transaction: ${id}`);
    }
    if (isFinal(record.status)) {
      throw new Error(
        `Cannot resume transaction ${id}: already ${record.status}`,
      );
    }

    return { metadata: toRecoveryMetadata(record) };
  }

  /**
   * Remove a transaction from the center. Intended for final transactions
   * (confirmed / failed) that the user has acknowledged. Non-final records
   * cannot be dismissed so recovery metadata is not lost.
   *
   * Throws if the transaction is unknown or not final.
   */
  dismissTransaction(id: string): void {
    this.ensureLoaded();

    const record = this.records.get(id);
    if (!record) {
      throw new Error(`Unknown transaction: ${id}`);
    }
    if (!isFinal(record.status)) {
      throw new Error(
        `Cannot dismiss transaction ${id}: status is ${record.status}`,
      );
    }

    this.records.delete(id);
    this.persist();
    this.emit();
  }

  /**
   * Clear all records. Primarily for tests and explicit user reset.
   */
  clear(): void {
    this.records.clear();
    this.loaded = true;
    const storage = getStorage();
    if (storage) {
      try {
        storage.removeItem(STORAGE_KEY);
      } catch {
        /* ignore */
      }
    }
    this.emit();
  }
}

/** Singleton transaction center instance. */
export const transactionCenter = new TransactionCenter();

/** Storage key, exported for tests and documentation. */
export const TRANSACTION_CENTER_STORAGE_KEY = STORAGE_KEY;

export { TransactionCenter };