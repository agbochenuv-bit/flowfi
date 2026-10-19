import { randomUUID } from "crypto";
import { hostname } from "os";
import { rpc, xdr, StrKey } from "@stellar/stellar-sdk";
import { prisma } from "../lib/prisma.js";
import { recordAuditEvent } from "../services/audit.service.js";
import { INDEXER_STATE_ID, ensureIndexerState } from "../lib/indexer-state.js";
import { sseService } from "../services/sse.service.js";
import { publishIndexerLag, quarantineEvent } from "../services/indexerService.js";
import {
  indexerEventsProcessedTotal,
  indexerPollsTotal,
  recordRpcRequest,
  recordIndexerLag,
  recordIndexerEventsPerLedger,
  recordIndexerDecodeLatency,
  recordIndexerPersistLatency,
  recordIndexerRetry,
  recordIndexerLastSuccess,
  recordIndexerBatch,
} from "../lib/metrics.js";
import {
  acquireIndexerLease,
  renewIndexerLease,
  releaseIndexerLease,
  isLeaseHeld,
  getHeldFencingToken,
  type IndexerLease,
} from "../lib/indexer-lease.js";
import { withSpan } from "../lib/tracing.js";
import logger, { requestContext } from "../logger.js";
import { Prisma } from "../generated/prisma/index.js";
import "../lib/stream-id.js";
import {
  computeStateRootHash,
  recordCheckpoint,
  verifyAndRecover,
  type LedgerHeader,
} from "../services/checkpoint.service.js";

// ─── Config ──────────────────────────────────────────────────────────────────

/** Ledger rollbacks above this ceiling are escalated to dead-letter triage. */
const REORG_ALERT_THRESHOLD_DEFAULT = 5;

/**
 * Default lease TTL for poll ownership. A replica must renew well before this
 * expires or another replica may take over the cursor.
 */
const LEASE_TTL_MS_DEFAULT = 30_000;
/** Renewal cadence; must be strictly shorter than the TTL (default TTL/3). */
const LEASE_RENEW_INTERVAL_MS_DEFAULT = 10_000;

/**
 * Default upper bound on the number of events persisted in a single batch
 * transaction. Keeps individual transactions bounded so a large ledger burst
 * cannot produce an unbounded write.
 */
const EVENT_BATCH_MAX_SIZE_DEFAULT = 100;

/**
 * Default upper bound (ms) on how long a batch transaction may run before the
 * batch is flushed. Bounds transaction duration under sustained load.
 */
const EVENT_BATCH_MAX_DURATION_MS_DEFAULT = 2_000;

/**
 * Default number of attempts for a batch transaction before the batch is
 * split and retried event-by-event (so a single poison event cannot drop the
 * whole batch).
 */
const EVENT_BATCH_MAX_ATTEMPTS_DEFAULT = 3;

// ─── XDR Decoding Helpers ────────────────────────────────────────────────────

/** Decode an ScVal symbol to a string. */
export function decodeSymbol(val: xdr.ScVal): string {
  return (val as xdr.ScValSymbol).sym.toString();
}

/**
 * Decode an ScVal U64 to a JavaScript bigint.
 * `xdr.UInt64` extends Long; `.toString()` gives the decimal representation.
 */
export function decodeU64(val: xdr.ScVal): bigint {
  return BigInt((val as xdr.ScValU64).u64.toString());
}

/** Decode an ScVal U32 to a JavaScript number. */
export function decodeU32(val: xdr.ScVal): number {
  return (val as xdr.ScValU32).u32;
}

/**
 * Decode an ScVal I128 to a decimal string suitable for DB storage.
 * I128 in XDR is split into hi (signed Int64) and lo (unsigned Uint64).
 * Full value = hi * 2^64 + lo.
 */
export function decodeI128(val: xdr.ScVal): string {
  const parts = (val as xdr.ScValI128).i128;
  const hi = BigInt.asIntN(64, BigInt(parts.hi.toString()));
  const lo = BigInt.asUintN(64, BigInt(parts.lo.toString()));
  return ((hi << 64n) | lo).toString();
}

/**
 * Decode an ScVal Address to a Stellar public key (G...) or contract (C...)
 * string.
 */
export function decodeAddress(val: xdr.ScVal): string {
  const addr = (val as xdr.ScValAddress).address;
  if (addr.type === 'scAddressTypeAccount') {
    return StrKey.encodeEd25519PublicKey((addr.accountId as xdr.PublicKeyEd25519).ed25519.value);
  }
  // addr.contractId is a Hash (Opaque[]); cast to Uint8Array for encodeContract
  const hash = (addr as xdr.ScAddressContract).contractId;
  return StrKey.encodeContract(Buffer.from(hash.value as unknown as Uint8Array));
}

/**
 * Decode an ScVal Map (a `#[contracttype]` struct) into a plain object keyed
 * by field name with raw ScVal values for further decoding.
 */
export function decodeMap(val: xdr.ScVal): Record<string, xdr.ScVal> {
  const result: Record<string, xdr.ScVal> = {};
  const entries = (val as xdr.ScValMap).map;
  if (!entries) return result;
  for (const entry of entries) {
    result[(entry.key as xdr.ScValSymbol).sym.toString()] = entry.val;
  }
  return result;
}

// ─── Event-processing counters / degraded signal ─────────────────────────────

/** Sliding window used to decide whether recent failures count as a "spike". */
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
/** Need at least this many attempts in the window before marking degraded. */
const MIN_SAMPLES_FOR_DEGRADED = 3;
/** Degraded when recent failure rate is at or above this threshold. */
const FAILURE_RATE_THRESHOLD = 0.5;

export interface IndexerEventCounters {
  eventsProcessed: number;
  eventsFailed: number;
  lastErrorAt: string | null;
  /** True when recent failure rate indicates a spike (not just lifetime totals). */
  degraded: boolean;
}

// ─── Worker Class ─────────────────────────────────────────────────────────────

export class SorobanEventWorker {
  private readonly contractId: string;
  private readonly server: rpc.Server;
  private readonly pollIntervalMs: number;
  private readonly startLedger: number;
  /** Ledger rollbacks larger than this are escalated to dead-letter triage. */
  private readonly reorgAlertThreshold: number;
  /** Max events persisted per batch transaction. */
  private readonly batchMaxSize: number;
  /** Max wall-clock duration (ms) a batch transaction may accumulate for. */
  private readonly batchMaxDurationMs: number;
  /** Max attempts for a batch transaction before falling back to per-event. */
  private readonly batchMaxAttempts: number;

  private isRunning = false;
  private pollTimer: NodeJS.Timeout | undefined;
  /** Interval handle for lease renewal while this replica owns the poll. */
  private leaseRenewTimer: NodeJS.Timeout | undefined;
  /** Stable identity for this replica: hostname + pid + random suffix. */
  private readonly ownerId: string;
  /** Lease TTL and renewal cadence (ms). */
  private readonly leaseTtlMs: number;
  private readonly leaseRenewIntervalMs: number;
  /** True while this replica holds the poll lease. */
  private leaseHeld = false;
  /** Fencing token of the currently-held lease (null when not held). */
  private fencingToken: number | null = null;
  /**
   * In-flight fetch/process work from either the scheduler or `triggerPoll`.
   * `waitForDrain()` awaits this so graceful shutdown covers replay batches too.
   */
  private activeBatch: Promise<void> | null = null;
  /** Promise chain that serializes all `fetchAndProcessEvents` invocations. */
  private batchMutex: Promise<void> = Promise.resolve();

  /** Lifetime count of events that processed without throwing. */
  private eventsProcessed = 0;
  /** Lifetime count of events that threw during processing. */
  private eventsFailed = 0;
  /** Timestamp of the most recent per-event processing failure. */
  private lastErrorAt: Date | null = null;
  /** Recent attempt outcomes for sliding-window spike detection. */
  private recentOutcomes: { ok: boolean; at: number }[] = [];

  constructor() {
    this.contractId = process.env.STREAM_CONTRACT_ID ?? "";
    const rpcUrl =
      process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
    this.server = new rpc.Server(rpcUrl, { allowHttp: true });
    this.pollIntervalMs = parseInt(
      process.env.INDEXER_POLL_INTERVAL_MS ?? "5000",
      10,
    );
    this.startLedger = parseInt(process.env.INDEXER_START_LEDGER ?? "0", 10);
    this.reorgAlertThreshold = parseInt(
      process.env.INDEXER_REORG_ALERT_THRESHOLD ??
        String(REORG_ALERT_THRESHOLD_DEFAULT),
      10,
    );
    this.ownerId =
      process.env.INDEXER_OWNER_ID ??
      `${hostname()}:${process.pid}:${randomUUID()}`;
    this.leaseTtlMs = parseInt(
      process.env.INDEXER_LEASE_TTL_MS ?? String(LEASE_TTL_MS_DEFAULT),
      10,
    );
    this.leaseRenewIntervalMs = parseInt(
      process.env.INDEXER_LEASE_RENEW_INTERVAL_MS ??
        String(LEASE_RENEW_INTERVAL_MS_DEFAULT),
      10,
    );
    this.batchMaxSize = Math.max(
      1,
      parseInt(
        process.env.INDEXER_EVENT_BATCH_MAX_SIZE ??
          String(EVENT_BATCH_MAX_SIZE_DEFAULT),
        10,
      ) || EVENT_BATCH_MAX_SIZE_DEFAULT,
    );
    this.batchMaxDurationMs = Math.max(
      1,
      parseInt(
        process.env.INDEXER_EVENT_BATCH_MAX_DURATION_MS ??
          String(EVENT_BATCH_MAX_DURATION_MS_DEFAULT),
        10,
      ) || EVENT_BATCH_MAX_DURATION_MS_DEFAULT,
    );
    this.batchMaxAttempts = Math.max(
      1,
      parseInt(
        process.env.INDEXER_EVENT_BATCH_MAX_ATTEMPTS ??
          String(EVENT_BATCH_MAX_ATTEMPTS_DEFAULT),
        10,
      ) || EVENT_BATCH_MAX_ATTEMPTS_DEFAULT,
    );
  }

  /** Stable owner identity used for lease acquisition (exposed for tests). */
  getOwnerId(): string {
    return this.ownerId;
  }

  /** True when this replica currently owns the poll lease. */
  hasLease(): boolean {
    return this.leaseHeld;
  }

  /**
   * Snapshot of event-processing counters for /health and admin metrics.
   * `degraded` is true when ≥50% of attempts in the last 5 minutes failed
   * (with at least 3 samples), so a broken indexer fails the health check
   * even when lag stays low because `updatedAt` is bumped every poll.
   */
  getEventCounters(): IndexerEventCounters {
    return {
      eventsProcessed: this.eventsProcessed,
      eventsFailed: this.eventsFailed,
      lastErrorAt: this.lastErrorAt?.toISOString() ?? null,
      degraded: this.isFailureSpike(),
    };
  }

  /** @internal Reset counters — used by unit tests. */
  resetEventCounters(): void {
    this.eventsProcessed = 0;
    this.eventsFailed = 0;
    this.lastErrorAt = null;
    this.recentOutcomes = [];
  }

  private recordOutcome(ok: boolean): void {
    const now = Date.now();
    this.recentOutcomes.push({ ok, at: now });
    const cutoff = now - FAILURE_WINDOW_MS;
    this.recentOutcomes = this.recentOutcomes.filter((o) => o.at >= cutoff);
  }

  private isFailureSpike(): boolean {
    const cutoff = Date.now() - FAILURE_WINDOW_MS;
    const recent = this.recentOutcomes.filter((o) => o.at >= cutoff);
    if (recent.length < MIN_SAMPLES_FOR_DEGRADED) return false;
    const failed = recent.filter((o) => !o.ok).length;
    return failed / recent.length >= FAILURE_RATE_THRESHOLD;
  }

  /**
   * Start the polling worker. If `STREAM_CONTRACT_ID` is not configured the
   * worker logs a warning and exits gracefully instead of throwing.
   */
  async start(): Promise<void> {
    if (!this.contractId) {
      logger.warn(
        "[SorobanWorker] STREAM_CONTRACT_ID is not set — event indexing disabled.",
      );
      return;
    }

    this.isRunning = true;
    logger.info("[SorobanWorker] Starting Soroban event indexer…");

    // Acquire the poll lease before the first cycle. If another replica owns
    // it we still schedule polls so we can take over once it expires.
    await this.tryAcquireLease();

    await this.poll();
  }

  /** Stop the worker gracefully. */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.stopLeaseRenewal();
    // Best-effort release so another replica can take over immediately.
    if (this.leaseHeld) {
      const token = this.fencingToken;
      this.leaseHeld = false;
      this.fencingToken = null;
      void releaseIndexerLease(this.ownerId, token).catch((err) => {
        logger.warn("[SorobanWorker] Failed to release indexer lease:", err);
      });
    }
    logger.info("[SorobanWorker] Stopped.");
  }

  // ─── Lease ownership ───────────────────────────────────────────────────────

  /** Attempt to acquire the poll lease; logs and returns false on failure. */
  private async tryAcquireLease(): Promise<boolean> {
    try {
      const lease: IndexerLease | null = await acquireIndexerLease(
        this.ownerId,
        this.leaseTtlMs,
      );
      if (!lease) return false;
      this.leaseHeld = true;
      this.fencingToken = lease.fencingToken;
      this.startLeaseRenewal();
      logger.info(
        `[SorobanWorker] Acquired indexer lease (owner=${this.ownerId}, token=${lease.fencingToken}).`,
      );
      return true;
    } catch (err) {
      logger.error("[SorobanWorker] Failed to acquire indexer lease:", err);
      return false;
    }
  }

  private startLeaseRenewal(): void {
    this.stopLeaseRenewal();
    this.leaseRenewTimer = setInterval(() => {
      void this.renewLease();
    }, this.leaseRenewIntervalMs);
    // Do not keep the process alive solely for lease renewal.
    this.leaseRenewTimer.unref?.();
  }

  private stopLeaseRenewal(): void {
    if (this.leaseRenewTimer) {
      clearInterval(this.leaseRenewTimer);
      this.leaseRenewTimer = undefined;
    }
  }

  private async renewLease(): Promise<void> {
    if (!this.leaseHeld) return;
    try {
      const renewed = await renewIndexerLease(
        this.ownerId,
        this.leaseTtlMs,
        this.fencingToken,
      );
      if (!renewed) {
        this.handleLeaseLoss("renewal rejected (lease taken over or expired)");
      }
    } catch (err) {
      logger.warn("[SorobanWorker] Indexer lease renewal failed:", err);
    }
  }

  /** Called when the lease is lost: stop polling and log loudly. */
  private handleLeaseLoss(reason: string): void {
    if (!this.leaseHeld) return;
    this.leaseHeld = false;
    this.fencingToken = null;
    this.stopLeaseRenewal();
    logger.error(
      `[SorobanWorker] Lost indexer lease (owner=${this.ownerId}): ${reason}. ` +
        `Polling halted; this replica will not advance the cursor.`,
    );
  }

  /** Wait for the currently-running poll/replay batch to finish (no-op if idle). */
  async waitForDrain(): Promise<void> {
    if (this.activeBatch) await this.activeBatch;
  }

  /**
   * Trigger an immediate poll cycle (used for replay and manual updates).
   * Serialized with the scheduled poll via `runExclusive` so two cursor writes
   * cannot overlap and regress `lastCursor` (#843).
   *
   * @param customRequestId Optional correlation ID to bind logs to a specific request/replay.
   * @returns The correlation requestId associated with this poll batch.
   */
  async triggerPoll(customRequestId?: string): Promise<string> {
    if (!this.isRunning) {
      return (
        customRequestId ||
        requestContext?.getStore?.()?.requestId ||
        randomUUID()
      );
    }

    const requestId =
      customRequestId ||
      requestContext?.getStore?.()?.requestId ||
      randomUUID();

    try {
      await this.runExclusive(() => {
        const runBatch = () => this.fetchAndProcessEvents();
        return requestContext && typeof requestContext.run === "function"
          ? requestContext.run({ requestId }, runBatch)
          : runBatch();
      });
    } catch (err) {
      logger.error("[SorobanWorker] Manual poll error:", err);
    }

    return requestId;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  /**
   * Run `fn` exclusively with any other poll/replay batch.
   * Registers the work on `activeBatch` so `waitForDrain` awaits replays too.
   *
   * Public so that admin reset/replay paths can acquire the same lock,
   * preventing a concurrent poll from overwriting the reset cursor (#1221).
   */
  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.batchMutex.then(fn);
    // Keep the mutex chain alive even when a batch rejects.
    const gate = run.then(
      () => undefined,
      () => undefined,
    );
    this.batchMutex = gate;
    this.activeBatch = gate;
    // Clear only if nothing newer registered on activeBatch after this gate.
    void gate.then(() => {
      if (this.activeBatch === gate) {
        this.activeBatch = null;
      }
    });
    return run;
  }

  private scheduleNext(): void {
    if (!this.isRunning) return;
    this.pollTimer = setTimeout(() => this.poll(), this.pollIntervalMs);
  }

  private async ensureSystemStream(
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const systemUser =
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    await tx.user.upsert({
      where: { publicKey: systemUser },
      create: { publicKey: systemUser },
      update: {},
    });
    await tx.stream.upsert({
      where: { streamId: 0n },
      create: {
        streamId: 0n,
        sender: systemUser,
        recipient: systemUser,
        tokenAddress:
          "CDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHF",
        ratePerSecond: "0",
        depositedAmount: "0",
        withdrawnAmount: "0",
        startTime: 0,
        lastUpdateTime: 0,
        endTime: 0,
        isActive: false,
      },
      update: {},
    });
  }

  private async poll(): Promise<void> {
    try {
      // Only the lease owner may poll. Non-owners attempt to acquire the lease
      // (which succeeds once the current owner's lease expires) and otherwise
      // skip this cycle entirely.
      if (!this.leaseHeld) {
        const acquired = await this.tryAcquireLease();
        if (!acquired) {
          logger.debug?.(
            "[SorobanWorker] Skipping poll — indexer lease held by another replica.",
          );
          return;
        }
      }

      const requestId = randomUUID();
      await this.runExclusive(() => {
        const execute = () =>
          this.fetchAndProcessEvents().catch((err) => {
            logger.error("[SorobanWorker] Unhandled error during poll:", err);
          });
        return requestContext && typeof requestContext.run === "function"
          ? requestContext.run({ requestId }, execute)
          : execute();
      });
    } finally {
      this.scheduleNext();
    }
  }

  /**
   * Fetch a batch of events from the Soroban RPC starting from the last known
   * cursor (or start ledger on first run) and process each one in order.
   */
  private async fetchAndProcessEvents(): Promise<void> {
    return withSpan(
      "indexer.poll",
      { "indexer.contract_id": this.contractId },
      async () => this.runPollCycle(),
    );
  }

  /** Checkpointing only makes sense once an event contract is configured. */
  private get checkpointsEnabled(): boolean {
    return this.contractId.length > 0;
  }

  /**
   * Canonical header for one ledger, or null when the RPC node cannot serve it
   * (pruned from retention, node desynced, transient error). Public so the
   * operator recovery path in `indexerService` can reuse it.
   */
  async fetchLedgerHeader(sequence: number): Promise<LedgerHeader | null> {
    const headers = await this.fetchLedgerHeaders(sequence, sequence);
    return headers.get(sequence) ?? null;
  }

  /**
   * Fetch canonical headers for an inclusive ledger range.
   *
   * `parentHash` is derived from the previous ledger in the same response so
   * consecutive checkpoints can be linked without decoding ledger-header XDR.
   */
  private async fetchLedgerHeaders(
    startLedger: number,
    endLedger: number,
  ): Promise<Map<number, LedgerHeader>> {
    const headers = new Map<number, LedgerHeader>();
    if (endLedger < startLedger) return headers;

    const PAGE_SIZE = 100;
    let next = Math.max(0, startLedger);
    while (next <= endLedger) {
      const limit = Math.min(PAGE_SIZE, endLedger - next + 1);
      const response = await this.server.getLedgers({
        startLedger: next,
        pagination: { limit },
      });
      const ledgers = response.ledgers ?? [];
      for (const info of ledgers) {
        headers.set(info.sequence, {
          sequence: info.sequence,
          hash: info.hash,
          parentHash: extractParentLedgerHash(info),
        });
      }
      const last = ledgers[ledgers.length - 1];
      if (!last || last.sequence < next) break;
      next = last.sequence + 1;
    }
    return headers;
  }

  /** Record a checkpoint for every ledger that produced events this cycle. */
  private async recordLedgerCheckpoints(
    processed: Map<
      number,
      Array<{ ledgerSequence: number; transactionHash: string; eventType: string }>
    >,
  ): Promise<void> {
    if (processed.size === 0) return;

    const ledgers = [...processed.keys()].sort((a, b) => a - b);
    const min = ledgers[0]!;
    const max = ledgers[ledgers.length - 1]!;

    let headers: Map<number, LedgerHeader>;
    try {
      // Include one ledger below the window so the oldest checkpoint can still
      // record a canonical parent hash.
      headers = await this.fetchLedgerHeaders(Math.max(0, min - 1), max);
    } catch (err) {
      logger.warn("[SorobanWorker] Unable to fetch ledger headers for checkpoints:", err);
      return;
    }

    for (const ledger of ledgers) {
      const header = headers.get(ledger);
      if (!header) continue;
      const events = processed.get(ledger)!;
      const parentHash = header.parentHash || headers.get(ledger - 1)?.hash || '';
      try {
        await recordCheckpoint({
          sequence: ledger,
          hash: header.hash,
          parentHash,
          eventsCount: events.length,
          stateRootHash: computeStateRootHash(events),
        });
      } catch (err) {
        logger.warn(`[SorobanWorker] Failed to record ledger checkpoint ${ledger}:`, err);
      }
    }
  }

  private async runPollCycle(): Promise<void> {
    // Re-check ownership at the start of the cycle: a lease may have been lost
    // between scheduling and execution. Never advance the cursor without it.
    if (!this.leaseHeld || this.fencingToken === null) {
      logger.warn(
        "[SorobanWorker] Aborting poll cycle — indexer lease not held.",
      );
      return;
    }
    const fencingToken = this.fencingToken;

    // Ensure an IndexerState row exists on first run.
    let state = await ensureIndexerState(this.startLedger);

    // Pre-ingestion verification (issue #1468): before advancing the cursor,
    // re-prove that the ledgers already checkpointed are still part of the
    // canonical chain. A hash mismatch means an RPC failover served us a stale
    // fork, so recover rolls every mutation above the last canonical ledger
    // back before any new ledger is ingested.
    if (this.checkpointsEnabled) {
      try {
        const recovery = await verifyAndRecover(
          (sequence) => this.fetchLedgerHeader(sequence),
          { alertThreshold: this.reorgAlertThreshold },
        );
        if (recovery.detected) {
          logger.warn(
            `[SorobanWorker] Reorg recovered: rolled back above ledger ` +
              `${recovery.rollback?.safeLedger}; re-ingesting from there.`,
          );
          state = await ensureIndexerState(this.startLedger);
        }
      } catch (err) {
        // A failure to verify is not a reorg: keep indexing forward rather than
        // halting the pipeline on a transient RPC/DB error.
        logger.error("[SorobanWorker] Ledger checkpoint verification failed:", err);
      }
    }

    const baseFilter = {
      filters: [
        {
          type: "contract" as const,
          contractIds: [this.contractId],
        },
      ],
      limit: 100,
    } satisfies Omit<
      Parameters<rpc.Server["getEvents"]>[0],
      "startLedger" | "cursor"
    >;

    // Prefer cursor-based pagination after the first poll so we never
    // re-process events.
    const params: Parameters<rpc.Server["getEvents"]>[0] = state.lastCursor
      ? { ...baseFilter, cursor: state.lastCursor }
      : { ...baseFilter, startLedger: state.lastLedger || this.startLedger };

    const rpcStart = Date.now();
    let response: Awaited<ReturnType<rpc.Server["getEvents"]>>;
    try {
      response = await this.server.getEvents(params);
      recordRpcRequest("getEvents", (Date.now() - rpcStart) / 1000, "success");
    } catch (err) {
      recordRpcRequest("getEvents", (Date.now() - rpcStart) / 1000, "error");
      indexerPollsTotal.inc({ outcome: "rpc_error" });
      recordIndexerRetry("rpc");
      throw err;
    }

    // The network tip is reported alongside every batch, so lag is observable
    // even on cycles that return no events.
    const networkLedger = response.latestLedger ?? 0;

    // Lag in ledgers between the last indexed ledger and the network tip.
    // Bounded labels only (no tx hashes / addresses).
    recordIndexerLag(Math.max(0, networkLedger - state.lastLedger));

    if (response.events.length === 0) {
      indexerPollsTotal.inc({ outcome: "empty" });
      publishIndexerLag(state.lastLedger, networkLedger);
      recordIndexerLastSuccess();
      return;
    }

    let lastCursor: string | null = state.lastCursor;
    let lastLedger: number = state.lastLedger;
    let sawSuccess = false;
    // Successfully processed events grouped by ledger, for checkpointing.
    const processedByLedger = new Map<
      number,
      Array<{ ledgerSequence: number; transactionHash: string; eventType: string }>
    >();

    // Sort events into canonical blockchain order before processing.
    //
    // Primary sort: ledger sequence ASC — events in earlier ledgers are always
    // applied before events in later ledgers, matching on-chain finality order.
    //
    // Secondary sort within the same ledger: stream_created comes first so that
    // the Stream row exists before any subsequent event (e.g. fee_collected,
    // topped_up) tries to reference it via the foreign key.
    //
    // Tertiary sort: event id (Soroban paging token) ASC — within the same
    // ledger and event-type group, paging tokens are lexicographically ordered
    // by (ledger, tx index, event index), which preserves transaction ordering.
    const sortedEvents = [...response.events].sort((a, b) => {
      // 1. Ledger sequence (ascending)
      if (a.ledger !== b.ledger) return a.ledger - b.ledger;

      // 2. stream_created before everything else within the same ledger
      const aType = a.topic[0] ? decodeSymbol(a.topic[0]) : "";
      const bType = b.topic[0] ? decodeSymbol(b.topic[0]) : "";
      const aIsCreated = aType === "stream_created" ? 0 : 1;
      const bIsCreated = bType === "stream_created" ? 0 : 1;
      if (aIsCreated !== bIsCreated) return aIsCreated - bIsCreated;

      // 3. Soroban paging token (lexicographic order preserves tx/event index)
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    // Accumulate events into bounded batches. Each batch is persisted in a
    // single transaction together with the cursor advance so events and cursor
    // commit atomically (no dropped events, no duplicate broadcasts).
    let batch: rpc.Api.EventResponse[] = [];
    let batchStartedAt = Date.now();

    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const pending = batch;
      batch = [];
      batchStartedAt = Date.now();

      const result = await this.persistEventBatch(pending);
      if (result.processed > 0) {
        sawSuccess = true;
        lastCursor = result.lastCursor ?? lastCursor;
        lastLedger = result.lastLedger ?? lastLedger;
        for (const entry of result.processedEvents) {
          const ledgerEvents = processedByLedger.get(entry.ledgerSequence) ?? [];
          ledgerEvents.push(entry);
          processedByLedger.set(entry.ledgerSequence, ledgerEvents);
        }
      }
    };

    for (const event of sortedEvents) {
      // Only process events from successful contract calls.
      if (!event.inSuccessfulContractCall) continue;

      const decodeStart = Date.now();
      const eventType = event.topic[0] ? decodeSymbol(event.topic[0]) : "unknown";
      recordIndexerDecodeLatency((Date.now() - decodeStart) / 1000);

      try {
        const persistStart = Date.now();
        await this.processEvent(event);
        recordIndexerPersistLatency((Date.now() - persistStart) / 1000);
        this.eventsProcessed += 1;
        this.recordOutcome(true);
        sawSuccess = true;
        const ledgerEvents = processedByLedger.get(event.ledger) ?? [];
        ledgerEvents.push({
          ledgerSequence: event.ledger,
          transactionHash: event.txHash,
          eventType,
        });
        processedByLedger.set(event.ledger, ledgerEvents);
        // Advance the cursor to the most recent event that was successfully processed.
        // This keeps a single malformed event from pinning the entire batch forever.
        lastCursor = event.id;
        lastLedger = event.ledger;
        indexerEventsProcessedTotal.inc({ eventType, result: "processed" });
      } catch (err) {
        indexerEventsProcessedTotal.inc({ eventType, result: "quarantined" });
        recordIndexerRetry("quarantine");
        logger.error(
          `[SorobanWorker] Failed to process event ${event.id}:`,
          err,
        );
        // Quarantine rather than retry inline: a payload the handler cannot
        // parse would otherwise be re-fetched every cycle and block everything
        // queued behind it. Operators replay it via the admin dead-letter API.
        await quarantineEvent(event, err);
        // Continue processing subsequent events rather than halting.
      }

      batch.push(event);

      const elapsed = Date.now() - batchStartedAt;
      if (
        batch.length >= this.batchMaxSize ||
        elapsed >= this.batchMaxDurationMs
      ) {
        await flush();
      }
      }
    }
    await flush();

    // Events per ledger for this batch (bounded: one observation per ledger).
    for (const [, ledgerEvents] of processedByLedger) {
      recordIndexerEventsPerLedger(ledgerEvents.length);
    }

    // If we successfully processed any events in the batch, advance to the last
    // successful event so a single poison-pill failure cannot freeze the cursor.
    const finalCursor = sawSuccess
      ? ((response as any).latestCursor || lastCursor)
      : lastCursor;

    // Persist a hash-signed checkpoint per ingested ledger. Best-effort: a
    // checkpoint write failure must not stall the cursor.
    if (this.checkpointsEnabled) {
      await this.recordLedgerCheckpoints(processedByLedger);
    }

    // Fenced cursor write: only the current lease owner may advance the cursor.
    // A stale worker whose lease expired (and was taken over) is rejected here
    // rather than clobbering the new owner's progress.
    const persisted = await this.persistCursorFenced(
      fencingToken,
      lastLedger,
      finalCursor,
    );
    if (!persisted) {
      // Ownership was lost mid-cycle; do not report success or advance lag.
      this.handleLeaseLoss("fenced cursor write rejected");
      return;
    }

    indexerPollsTotal.inc({ outcome: "processed" });
    publishIndexerLag(lastLedger, networkLedger);
    recordIndexerLastSuccess();

    logger.info(
      `[SorobanWorker] Processed ${response.events.length} event(s) — latest ledger: ${lastLedger}`,
    );
  }

  /**
   * Advance the indexer cursor only if `fencingToken` still matches the lease
   * held in the database. Returns false when the write was fenced out (the
   * lease was lost or taken over), in which case the caller must stop.
   */
  private async persistCursorFenced(
    fencingToken: number,
    lastLedger: number,
    lastCursor: string | null,
  ): Promise<boolean> {
    const held = await isLeaseHeld(this.ownerId, fencingToken);
    if (!held) return false;

    await prisma.indexerState.upsert({
      where: { id: INDEXER_STATE_ID },
      create: {
        id: INDEXER_STATE_ID,
        lastLedger,
        lastCursor,
      },
      update: { lastLedger, lastCursor },
    });
    return true;
  }

  /**
   * Persist a bounded batch of events atomically.
   *
   * Each event is dispatched through `processEvent` inside a single Prisma
   * transaction so the batch's writes commit together. If the batch
   * transaction fails, it is retried up to `batchMaxAttempts` times; if it
   * still fails, the batch is split and retried event-by-event so a single
   * poison event is quarantined without dropping the rest of the batch.
   *
   * Returns the events that were successfully processed, along with the
   * cursor/ledger of the last successful event.
   */
  private async persistEventBatch(
    events: rpc.Api.EventResponse[],
  ): Promise<{
    processed: number;
    lastCursor: string | null;
    lastLedger: number | null;
    processedEvents: Array<{
      ledgerSequence: number;
      transactionHash: string;
      eventType: string;
    }>;
  }> {
    const startedAt = Date.now();
    let lastCursor: string | null = null;
    let lastLedger: number | null = null;
    const processedEvents: Array<{
      ledgerSequence: number;
      transactionHash: string;
      eventType: string;
    }> = [];

    let attempt = 0;
    let remaining = events;
    while (remaining.length > 0) {
      attempt += 1;
      try {
        await prisma.$transaction(
          async () => {
            for (const event of remaining) {
              await this.processEvent(event);
            }
          },
          { timeout: this.batchMaxDurationMs },
        );

        for (const event of remaining) {
          const eventType = event.topic[0]
            ? decodeSymbol(event.topic[0])
            : "unknown";
          this.eventsProcessed += 1;
          this.recordOutcome(true);
          processedEvents.push({
            ledgerSequence: event.ledger,
            transactionHash: event.txHash,
            eventType,
          });
          lastCursor = event.id;
          lastLedger = event.ledger;
          indexerEventsProcessedTotal.inc({ eventType, result: "processed" });
        }
        break;
      } catch (err) {
        recordIndexerBatch({
          size: remaining.length,
          latencyMs: Date.now() - startedAt,
          retries: attempt - 1,
          outcome: "error",
        });
        if (attempt >= this.batchMaxAttempts) {
          logger.error(
            `[SorobanWorker] Batch of ${remaining.length} event(s) failed after ` +
              `${attempt} attempt(s); falling back to per-event processing.`,
            err,
          );
          // Fall back to per-event processing so a single poison event is
          // quarantined without dropping the rest of the batch.
          for (const event of remaining) {
            const eventType = event.topic[0]
              ? decodeSymbol(event.topic[0])
              : "unknown";
            try {
              await this.processEvent(event);
              this.eventsProcessed += 1;
              this.recordOutcome(true);
              processedEvents.push({
                ledgerSequence: event.ledger,
                transactionHash: event.txHash,
                eventType,
              });
              lastCursor = event.id;
              lastLedger = event.ledger;
              indexerEventsProcessedTotal.inc({
                eventType,
                result: "processed",
              });
            } catch (eventErr) {
              indexerEventsProcessedTotal.inc({
                eventType,
                result: "quarantined",
              });
              logger.error(
                `[SorobanWorker] Failed to process event ${event.id}:`,
                eventErr,
              );
              await quarantineEvent(event, eventErr);
            }
          }
          break;
        }
        logger.warn(
          `[SorobanWorker] Batch attempt ${attempt} failed; retrying ` +
            `${remaining.length} event(s).`,
          err,
        );
      }
    }

    recordIndexerBatch({
      size: events.length,
      latencyMs: Date.now() - startedAt,
      retries: Math.max(0, attempt - 1),
      outcome: "success",
    });

    return {
      processed: processedEvents.length,
      lastCursor,
      lastLedger,
      processedEvents,
    };
  }

  /**
   * Dispatch a single contract event to the appropriate handler based on the
   * first topic symbol.
   */
  public async processEvent(event: rpc.Api.EventResponse): Promise<void> {
    if (!event.topic || event.topic.length < 1) return;

    const topic0: xdr.ScVal | undefined = event.topic[0];
    if (!topic0) return;

    const eventName = decodeSymbol(topic0);

    if (
      eventName === "fee_config_updated" ||
      eventName === "admin_transferred"
    ) {
      if (eventName === "fee_config_updated") {
        await this.handleFeeConfigUpdated(event);
      } else {
        await this.handleAdminTransferred(event);
      }
      return;
    }

    if (event.topic.length < 2) return;
    const topic1: xdr.ScVal | undefined = event.topic[1];
    if (!topic1) return;

    switch (eventName) {
      case "stream_created":
        await this.handleStreamCreated(event, topic1);
        break;
      case "stream_topped_up":
        await this.handleStreamToppedUp(event, topic1);
        break;
      case "tokens_withdrawn":
        await this.handleTokensWithdrawn(event, topic1);
        break;
      case "stream_paused":
        await this.handleStreamPaused(event, topic1);
        break;
      case "stream_resumed":
        await this.handleStreamResumed(event, topic1);
        break;
      case "stream_cancelled":
        await this.handleStreamCancelled(event, topic1);
        break;
      case "stream_completed":
        await this.handleStreamCompleted(event, topic1);
        break;
      case "fee_collected":
        await this.handleFeeCollected(event, topic1);
        break;
      default:
        // Unrecognised event — ignore silently.
        break;
    }
  }

  private async handleFeeConfigUpdated(
    event: rpc.Api.EventResponse,
  ): Promise<void> {
    const body = decodeMap(event.value);

    if (
      !body["admin"] ||
      !body["old_treasury"] ||
      !body["new_treasury"] ||
      body["old_fee_rate_bps"] === undefined ||
      body["new_fee_rate_bps"] === undefined
    ) {
      throw new Error("FeeConfigUpdated: missing body fields");
    }

    const admin = decodeAddress(body["admin"]);
    const oldTreasury = decodeAddress(body["old_treasury"]);
    const newTreasury = decodeAddress(body["new_treasury"]);
    const oldFeeRateBps = decodeU32(body["old_fee_rate_bps"]);
    const newFeeRateBps = decodeU32(body["new_fee_rate_bps"]);
    const timestamp = Math.floor(Date.now() / 1000);

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.ensureSystemStream(tx);

      await tx.streamEvent.upsert({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "FEE_CONFIG_UPDATED",
          },
        },
        create: {
          streamId: 0n,
          eventType: "FEE_CONFIG_UPDATED",
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({
            admin,
            old_treasury: oldTreasury,
            new_treasury: newTreasury,
            old_fee_rate_bps: oldFeeRateBps,
            new_fee_rate_bps: newFeeRateBps,
          }),
        },
        update: {
          ledgerSequence: event.ledger,
          timestamp,
        },
      });

      await recordAuditEvent({
        actor: admin,
        action: "protocol.fee_config.update",
        targetType: "protocol_fee_config",
        targetId: event.txHash,
        outcome: "success",
        before: { treasury: oldTreasury, feeRateBps: oldFeeRateBps },
        after: { treasury: newTreasury, feeRateBps: newFeeRateBps },
        metadata: { transactionHash: event.txHash, ledger: event.ledger },
      }, tx);
    });

    sseService.broadcastToAdmin("stream.fee_config_updated", {
      admin,
      oldTreasury,
      newTreasury,
      oldFeeRateBps,
      newFeeRateBps,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    });
  }

  private async handleAdminTransferred(
    event: rpc.Api.EventResponse,
  ): Promise<void> {
    const body = decodeMap(event.value);

    if (!body["previous_admin"] || !body["new_admin"]) {
      throw new Error("AdminTransferred: missing body fields");
    }

    const previousAdmin = decodeAddress(body["previous_admin"]);
    const newAdmin = decodeAddress(body["new_admin"]);
    const timestamp = Math.floor(Date.now() / 1000);

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.ensureSystemStream(tx);

      await tx.streamEvent.upsert({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "ADMIN_TRANSFERRED",
          },
        },
        create: {
          streamId: 0n,
          eventType: "ADMIN_TRANSFERRED",
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({
            previous_admin: previousAdmin,
            new_admin: newAdmin,
            transactionHash: event.txHash,
          }),
        },
        update: {
          ledgerSequence: event.ledger,
          timestamp,
        },
      });
    });

    sseService.broadcastToAdmin("stream.admin_transferred", {
      previousAdmin,
      newAdmin,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
    });
  }

  // ─── Event Handlers ────────────────────────────────────────────────────────

  private async handleStreamCreated(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = decodeU64(streamIdTopic);
    const body = decodeMap(event.value);

    if (
      !body["sender"] ||
      !body["recipient"] ||
      !body["token_address"] ||
      !body["rate_per_second"] ||
      !body["deposited_amount"] ||
      !body["start_time"]
    ) {
      throw new Error(`StreamCreated #${streamId}: missing body fields`);
    }

    const sender = decodeAddress(body["sender"]);
    const recipient = decodeAddress(body["recipient"]);
    const tokenAddress = decodeAddress(body["token_address"]);
    const ratePerSecond = decodeI128(body["rate_per_second"]);
    const depositedAmount = decodeI128(body["deposited_amount"]);
    const startTime = BigInt(decodeU64(body["start_time"]));

    const ratePerSecondBigInt = BigInt(ratePerSecond);
    const endTime =
      ratePerSecondBigInt === 0n
        ? null
        : startTime + BigInt(depositedAmount) / ratePerSecondBigInt;

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.user.upsert({
        where: { publicKey: sender },
        create: { publicKey: sender },
        update: {},
      });
      await tx.user.upsert({
        where: { publicKey: recipient },
        create: { publicKey: recipient },
        update: {},
      });

      await tx.stream.upsert({
        where: { streamId },
        create: {
          streamId,
          sender,
          recipient,
          tokenAddress,
          ratePerSecond,
          depositedAmount,
          withdrawnAmount: "0",
          startTime,
          endTime,
          lastUpdateTime: startTime,
          isActive: true,
        },
        update: {
          tokenAddress,
          ratePerSecond,
          depositedAmount,
          startTime,
          endTime,
          lastUpdateTime: startTime,
          isActive: true,
        },
      });

      const existingEvent = await tx.streamEvent.findUnique({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "CREATED",
          },
        },
        select: { id: true },
      });
      if (existingEvent) {
        logger.warn(
          `[SorobanWorker] Duplicate StreamEvent skipped: txHash=${event.txHash} type=CREATED`,
        );
      } else {
        await tx.streamEvent.upsert({
          where: {
            transactionHash_eventType: {
              transactionHash: event.txHash,
              eventType: "CREATED",
            },
          },
          create: {
            streamId,
            eventType: "CREATED",
            amount: depositedAmount,
            transactionHash: event.txHash,
            ledgerSequence: event.ledger,
            timestamp: startTime,
            metadata: JSON.stringify({ tokenAddress, ratePerSecond }),
          },
          update: {
            ledgerSequence: event.ledger,
            timestamp: startTime,
          },
        });
      }
    });

    sseService.broadcastToStream(String(streamId), "stream.created", {
      streamId,
      sender,
      recipient,
      tokenAddress,
      ratePerSecond,
      depositedAmount,
      startTime,
      transactionHash: event.txHash,
      ledger: event.ledger,
      // Ordering metadata — clients use these fields to detect and
      // re-sequence out-of-order delivery. The canonical order is
      // (ledgerSequence ASC, eventId ASC). eventId is the Soroban paging
      // token: "<ledger>-<txIndex>-<eventIndex>".
      _ordering: {
        ledgerSequence: event.ledger,
        eventId: event.id,
        eventType: "CREATED",
      },
    });
  }

  private async handleStreamToppedUp(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = decodeU64(streamIdTopic);
    const body = decodeMap(event.value);

    if (!body["amount"] || !body["new_deposited_amount"]) {
      throw new Error(`StreamToppedUp #${streamId}: missing body fields`);
    }

    const amount = decodeI128(body["amount"]);
    const newDepositedAmount = decodeI128(body["new_deposited_amount"]);
    const timestamp = Math.floor(Date.now() / 1000);

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Check for a duplicate BEFORE mutating any Stream fields so that a
      // replayed event never re-applies the top-up.
      const existingEvent = await tx.streamEvent.findUnique({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "TOPPED_UP",
          },
        },
        select: { id: true },
      });
      if (existingEvent) {
        logger.warn(
          `[SorobanWorker] Duplicate StreamEvent skipped: txHash=${event.txHash} type=TOPPED_UP`,
        );
        return;
      }

      const stream = await tx.stream.findUniqueOrThrow({
        where: { streamId },
        select: {
          ratePerSecond: true,
          startTime: true,
          totalPausedDuration: true,
        },
      });

      const ratePerSecondBigInt = BigInt(stream.ratePerSecond);
      const newEndTime =
        ratePerSecondBigInt === 0n
          ? null
          : BigInt(stream.startTime) +
            BigInt(newDepositedAmount) / ratePerSecondBigInt +
            BigInt(stream.totalPausedDuration);

      await tx.stream.update({
        where: { streamId },
        data: {
          depositedAmount: newDepositedAmount,
          endTime: newEndTime,
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.upsert({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "TOPPED_UP",
          },
        },
        create: {
          streamId,
          eventType: "TOPPED_UP",
          amount,
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ newDepositedAmount }),
        },
        update: {
          ledgerSequence: event.ledger,
          timestamp,
        },
      });
    });

    sseService.broadcastToStream(String(streamId), "stream.topped_up", {
      streamId,
      amount,
      newDepositedAmount,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
      _ordering: {
        ledgerSequence: event.ledger,
        eventId: event.id,
        eventType: "TOPPED_UP",
      },
    });
  }

  private async handleTokensWithdrawn(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = decodeU64(streamIdTopic);
    const body = decodeMap(event.value);

    if (!body["recipient"] || !body["amount"] || !body["timestamp"]) {
      throw new Error(`TokensWithdrawn #${streamId}: missing body fields`);
    }

    const recipient = decodeAddress(body["recipient"]);
    const amount = decodeI128(body["amount"]);
    const timestamp = Number(decodeU64(body["timestamp"]));

    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Check for a duplicate BEFORE mutating any Stream fields so that a
      // replayed event never double-increments withdrawnAmount.
      const existingEvent = await tx.streamEvent.findUnique({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "WITHDRAWN",
          },
        },
        select: { id: true },
      });
      if (existingEvent) {
        logger.warn(
          `[SorobanWorker] Duplicate StreamEvent skipped: txHash=${event.txHash} type=WITHDRAWN`,
        );
        return;
      }

      const stream = await tx.stream.findUniqueOrThrow({
        where: { streamId },
        select: { withdrawnAmount: true },
      });

      const newWithdrawnAmount = (
        BigInt(stream.withdrawnAmount) + BigInt(amount)
      ).toString();

      await tx.stream.update({
        where: { streamId },
        data: {
          withdrawnAmount: newWithdrawnAmount,
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.upsert({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "WITHDRAWN",
          },
        },
        create: {
          streamId,
          eventType: "WITHDRAWN",
          amount,
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ recipient }),
        },
        update: {
          ledgerSequence: event.ledger,
          timestamp,
        },
      });
    });

    sseService.broadcastToStream(String(streamId), "stream.withdrawn", {
      streamId,
      recipient,
      amount,
      transactionHash: event.txHash,
      ledger: event.ledger,
      timestamp,
      _ordering: {
        ledgerSequence: event.ledger,
        eventId: event.id,
        eventType: "WITHDRAWN",
      },
    });
  }

  private async handleStreamCancelled(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = decodeU64(streamIdTopic);
    const body = decodeMap(event.value);

    if (!body["amount_withdrawn"] || !body["refunded_amount"]) {
      throw new Error(`StreamCancelled #${streamId}: missing body fields`);
    }

    const amountWithdrawn = decodeI128(body["amount_withdrawn"]);
    const refundedAmount = decodeI128(body["refunded_amount"]);
    const timestamp = Math.floor(Date.now() / 1000);

    let inserted = false;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existingEvent = await tx.streamEvent.findUnique({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "CANCELLED",
          },
        },
        select: { id: true },
      });
      if (existingEvent) {
        logger.warn(
          `[SorobanWorker] Duplicate StreamEvent skipped: txHash=${event.txHash} type=CANCELLED`,
        );
        return;
      }

      await tx.stream.update({
        where: { streamId },
        data: {
          isActive: false,
          withdrawnAmount: amountWithdrawn,
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.upsert({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "CANCELLED",
          },
        },
        create: {
          streamId,
          eventType: "CANCELLED",
          amount: refundedAmount,
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ amountWithdrawn, refundedAmount }),
        },
        update: {
          ledgerSequence: event.ledger,
          timestamp,
        },
      });
      inserted = true;
    });

    if (inserted) {
      sseService.broadcastToStream(String(streamId), "stream.cancelled", {
        streamId,
        refundedAmount,
        amountWithdrawn,
        transactionHash: event.txHash,
        ledger: event.ledger,
        timestamp,
        _ordering: {
          ledgerSequence: event.ledger,
          eventId: event.id,
          eventType: "CANCELLED",
        },
      });
    }
  }

  private async handleStreamCompleted(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = decodeU64(streamIdTopic);
    const body = decodeMap(event.value);

    if (!body["recipient"] || !body["total_withdrawn"]) {
      throw new Error(`StreamCompleted #${streamId}: missing body fields`);
    }

    const recipient = decodeAddress(body["recipient"]);
    const totalWithdrawn = decodeI128(body["total_withdrawn"]);
    const timestamp = Math.floor(Date.now() / 1000);

    let inserted = false;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existingEvent = await tx.streamEvent.findUnique({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "COMPLETED",
          },
        },
        select: { id: true },
      });
      if (existingEvent) {
        logger.warn(
          `[SorobanWorker] Duplicate StreamEvent skipped: txHash=${event.txHash} type=COMPLETED`,
        );
        return;
      }

      await tx.stream.update({
        where: { streamId },
        data: {
          isActive: false,
          withdrawnAmount: totalWithdrawn,
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.upsert({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "COMPLETED",
          },
        },
        create: {
          streamId,
          eventType: "COMPLETED",
          amount: totalWithdrawn,
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ recipient }),
        },
        update: {
          ledgerSequence: event.ledger,
          timestamp,
        },
      });
      inserted = true;
    });

    if (inserted) {
      sseService.broadcastToStream(String(streamId), "stream.completed", {
        streamId,
        recipient,
        totalWithdrawn,
        transactionHash: event.txHash,
        ledger: event.ledger,
        timestamp,
        _ordering: {
          ledgerSequence: event.ledger,
          eventId: event.id,
          eventType: "COMPLETED",
        },
      });
    }
  }

  private async handleFeeCollected(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = decodeU64(streamIdTopic);
    const body = decodeMap(event.value);

    if (!body["treasury"] || !body["fee_amount"] || !body["token"]) {
      throw new Error(`FeeCollected #${streamId}: missing body fields`);
    }

    const treasury = decodeAddress(body["treasury"]);
    const feeAmount = decodeI128(body["fee_amount"]);
    const token = decodeAddress(body["token"]);
    const timestamp = Math.floor(Date.now() / 1000);

    let inserted = false;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existingEvent = await tx.streamEvent.findUnique({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "FEE_COLLECTED",
          },
        },
        select: { id: true },
      });
      if (existingEvent) {
        logger.warn(
          `[SorobanWorker] Duplicate StreamEvent skipped: txHash=${event.txHash} type=FEE_COLLECTED`,
        );
        return;
      }
      await tx.streamEvent.upsert({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "FEE_COLLECTED",
          },
        },
        create: {
          streamId,
          eventType: "FEE_COLLECTED",
          amount: feeAmount,
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ treasury, token }),
        },
        update: {},
      });
      inserted = true;
    });

    // Broadcast to admin channel for treasury reporting. Only broadcast when
    // the event was actually inserted so replays never duplicate broadcasts.
    if (inserted) {
      sseService.broadcastToAdmin("stream.fee_collected", {
        streamId,
        treasury,
        feeAmount,
        token,
        transactionHash: event.txHash,
        ledger: event.ledger,
        timestamp,
        // Ordering metadata — clients use these fields to detect and
        // re-sequence out-of-order delivery. The canonical order is
        // (ledgerSequence ASC, eventId ASC). eventId is the Soroban paging
        // token: "<ledger>-<txIndex>-<eventIndex>".
        _ordering: {
          ledgerSequence: event.ledger,
          eventId: event.id,
          eventType: "FEE_COLLECTED",
        },
      });
    }
  }
  private async handleStreamPaused(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = decodeU64(streamIdTopic);
    const body = decodeMap(event.value);

    if (!body["sender"] || !body["paused_at"]) {
      throw new Error(`StreamPaused #${streamId}: missing body fields`);
    }

    const sender = decodeAddress(body["sender"]);
    const pausedAt = Number(decodeU64(body["paused_at"]));
    const timestamp = Math.floor(Date.now() / 1000);

    let inserted = false;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existingEvent = await tx.streamEvent.findUnique({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "PAUSED",
          },
        },
        select: { id: true },
      });
      if (existingEvent) {
        logger.warn(
          `[SorobanWorker] Duplicate StreamEvent skipped: txHash=${event.txHash} type=PAUSED`,
        );
        return;
      }

      await tx.stream.update({
        where: { streamId },
        data: {
          isPaused: true,
          pausedAt,
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.upsert({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "PAUSED",
          },
        },
        create: {
          streamId,
          eventType: "PAUSED",
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({ sender, pausedAt }),
        },
        update: {
          ledgerSequence: event.ledger,
          timestamp,
        },
      });
      inserted = true;
    });

    if (inserted) {
      sseService.broadcastToStream(String(streamId), "stream.paused", {
        streamId,
        sender,
        pausedAt,
        transactionHash: event.txHash,
        ledger: event.ledger,
        timestamp,
        _ordering: {
          ledgerSequence: event.ledger,
          eventId: event.id,
          eventType: "PAUSED",
        },
      });
    }
  }

  private async handleStreamResumed(
    event: rpc.Api.EventResponse,
    streamIdTopic: xdr.ScVal,
  ): Promise<void> {
    const streamId = decodeU64(streamIdTopic);
    const body = decodeMap(event.value);

    if (!body["sender"] || !body["new_end_time"]) {
      throw new Error(`StreamResumed #${streamId}: missing body fields`);
    }

    const sender = decodeAddress(body["sender"]);
    const newEndTime = decodeU64(body["new_end_time"]);
    const timestamp = Math.floor(Date.now() / 1000);

    let inserted = false;
    let additionalPausedDuration = 0;
    let newTotalPausedDuration = 0;
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const existingEvent = await tx.streamEvent.findUnique({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "RESUMED",
          },
        },
        select: { id: true },
      });
      if (existingEvent) {
        logger.warn(
          `[SorobanWorker] Duplicate StreamEvent skipped: txHash=${event.txHash} type=RESUMED`,
        );
        return;
      }

      // Get current stream to calculate paused duration
      const currentStream = await tx.stream.findUniqueOrThrow({
        where: { streamId },
        select: { pausedAt: true, totalPausedDuration: true },
      });

      additionalPausedDuration = currentStream.pausedAt
        ? timestamp - Number(currentStream.pausedAt)
        : 0;

      newTotalPausedDuration =
        currentStream.totalPausedDuration + additionalPausedDuration;

      await tx.stream.update({
        where: { streamId },
        data: {
          isPaused: false,
          pausedAt: null,
          endTime: newEndTime,
          totalPausedDuration: newTotalPausedDuration,
          lastUpdateTime: timestamp,
        },
      });

      await tx.streamEvent.upsert({
        where: {
          transactionHash_eventType: {
            transactionHash: event.txHash,
            eventType: "RESUMED",
          },
        },
        create: {
          streamId,
          eventType: "RESUMED",
          transactionHash: event.txHash,
          ledgerSequence: event.ledger,
          timestamp,
          metadata: JSON.stringify({
            sender,
            newEndTime: newEndTime.toString(),
            pausedDuration: additionalPausedDuration,
            totalPausedDuration: newTotalPausedDuration,
          }),
        },
        update: {
          ledgerSequence: event.ledger,
          timestamp,
        },
      });
      inserted = true;
    });

    if (inserted) {
      sseService.broadcastToStream(String(streamId), "stream.resumed", {
        streamId,
        sender,
        newEndTime: newEndTime.toString(),
        transactionHash: event.txHash,
        ledger: event.ledger,
        timestamp,
        _ordering: {
          ledgerSequence: event.ledger,
          eventId: event.id,
          eventType: "RESUMED",
        },
      });
    }
  }
}

/**
 * Extract the canonical parent hash from a ledger header response.
 *
 * The SDK exposes the header as a parsed `LedgerHeaderHistoryEntry`; its
 * `previousLedgerHash()` accessor is the canonical link to the ledger before
 * it. Returns '' when the shape is unexpected so checkpointing never aborts on
 * a cosmetic decode issue.
 */
function extractParentLedgerHash(info: rpc.Api.LedgerResponse): string {
  try {
    const entry = info.headerXdr as unknown as {
      header?: { previousLedgerHash?: () => Buffer | Uint8Array };
    };
    const previous = entry?.header?.previousLedgerHash?.();
    if (previous) return Buffer.from(previous).toString('hex');
  } catch {
    // Fall through to the empty hash.
  }
  return '';
}

export const sorobanEventWorker = new SorobanEventWorker();
