import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { redisHelper } from '../utils/redis.helper';

/**
 * Idempotency middleware for retryable stream commands.
 *
 * Contract:
 *  - Clients send an `Idempotency-Key` header on commands that submit on-chain
 *    transactions (e.g. stream create/update/cancel).
 *  - The key is bound to `(wallet, operation, requestHash)`. The request hash is
 *    a stable SHA-256 over the operation, wallet and canonicalized request body.
 *  - On the first request the middleware acquires a short-lived lock, marks the
 *    key as in-flight, and lets the handler run. The final response (status +
 *    body) is persisted with a bounded TTL.
 *  - On retry with the same key and matching hash, the stored result is
 *    returned without re-executing the handler.
 *  - On retry with the same key but a different hash (changed input), the
 *    request is rejected with a stable `IDEMPOTENCY_CONFLICT` error.
 *  - Concurrent duplicates are serialized by the lock so at most one
 *    transaction is submitted; losers wait for the winner's result.
 *
 * Storage falls back to the Redis helper's in-memory store when Redis is
 * unavailable, preserving the same semantics within a single process.
 */

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_CONFLICT = 'IDEMPOTENCY_CONFLICT';
export const IDEMPOTENCY_IN_PROGRESS = 'IDEMPOTENCY_IN_PROGRESS';

/** Bounded retention for stored results (24 hours). */
const RESULT_TTL_SECONDS = 24 * 60 * 60;
/** Lock lifetime; long enough to cover a transaction submission. */
const LOCK_TTL_SECONDS = 60;
/** How long a duplicate waits for the in-flight winner before giving up. */
const IN_FLIGHT_WAIT_MS = 30_000;
const IN_FLIGHT_POLL_MS = 100;

interface StoredResult {
  status: number;
  body: unknown;
  requestHash: string;
  wallet: string;
  operation: string;
  completedAt: number;
}

interface InFlightMarker {
  requestHash: string;
  wallet: string;
  operation: string;
  startedAt: number;
}

interface IdempotencyRecord {
  state: 'in_flight' | 'completed';
  requestHash: string;
  wallet: string;
  operation: string;
  result?: StoredResult;
  startedAt: number;
}

export interface IdempotencyOptions {
  /** Override the operation name; defaults to `METHOD path`. */
  operation?: (req: Request) => string;
  /** Override the wallet extraction; defaults to body/query/header lookup. */
  wallet?: (req: Request) => string | undefined;
  /** Override retention for stored results. */
  ttlSeconds?: number;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalize(obj[key]);
        return acc;
      }, {});
  }
  return value;
}

function computeRequestHash(
  operation: string,
  wallet: string,
  body: unknown,
): string {
  const payload = JSON.stringify({
    operation,
    wallet,
    body: canonicalize(body ?? {}),
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function defaultOperation(req: Request): string {
  return `${req.method.toUpperCase()} ${req.baseUrl || ''}${req.path}`;
}

function defaultWallet(req: Request): string | undefined {
  const body = req.body as Record<string, unknown> | undefined;
  const query = req.query as Record<string, unknown> | undefined;
  const candidate =
    (body && (body.wallet as string | undefined)) ||
    (body && (body.walletAddress as string | undefined)) ||
    (query && (query.wallet as string | undefined)) ||
    (req.header('x-wallet') as string | undefined);
  return candidate ? String(candidate).toLowerCase() : undefined;
}

function recordKey(key: string): string {
  return `idempotency:record:${key}`;
}

function lockKey(key: string): string {
  return `idempotency:lock:${key}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readRecord(key: string): Promise<IdempotencyRecord | null> {
  const raw = await redisHelper.get(recordKey(key));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as IdempotencyRecord;
  } catch {
    return null;
  }
}

async function writeRecord(
  key: string,
  record: IdempotencyRecord,
  ttlSeconds: number,
): Promise<void> {
  await redisHelper.set(recordKey(key), JSON.stringify(record), ttlSeconds);
}

async function acquireLock(key: string): Promise<boolean> {
  // SET NX semantics via the helper; returns true when acquired.
  return redisHelper.setIfNotExists(lockKey(key), '1', LOCK_TTL_SECONDS);
}

async function releaseLock(key: string): Promise<void> {
  await redisHelper.del(lockKey(key));
}

function sendConflict(res: Response): void {
  res.status(409).json({
    error: IDEMPOTENCY_CONFLICT,
    message:
      'Idempotency-Key was reused with a different request payload. ' +
      'Use a new key for a new command.',
  });
}

function sendInProgress(res: Response): void {
  res.status(409).json({
    error: IDEMPOTENCY_IN_PROGRESS,
    message:
      'A request with this Idempotency-Key is still in progress. Retry shortly.',
  });
}

/**
 * Express middleware factory.
 */
export function idempotencyMiddleware(options: IdempotencyOptions = {}) {
  const getOperation = options.operation ?? defaultOperation;
  const getWallet = options.wallet ?? defaultWallet;
  const ttlSeconds = options.ttlSeconds ?? RESULT_TTL_SECONDS;

  return async function idempotency(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const key = req.header(IDEMPOTENCY_HEADER);
    if (!key) {
      // No key supplied: behave as a normal request (backwards compatible).
      next();
      return;
    }

    const operation = getOperation(req);
    const wallet = getWallet(req);
    if (!wallet) {
      res.status(400).json({
        error: 'WALLET_REQUIRED',
        message: 'A wallet is required for idempotent stream commands.',
      });
      return;
    }

    const requestHash = computeRequestHash(operation, wallet, req.body);

    // Fast path: a completed record already exists.
    const existing = await readRecord(key);
    if (existing) {
      if (existing.requestHash !== requestHash) {
        sendConflict(res);
        return;
      }
      if (existing.state === 'completed' && existing.result) {
        res.status(existing.result.status).json(existing.result.body);
        return;
      }
      // In-flight: wait for the winner to finish.
      const waited = await waitForCompletion(key, requestHash);
      if (waited) {
        if (waited.requestHash !== requestHash) {
          sendConflict(res);
          return;
        }
        if (waited.result) {
          res.status(waited.result.status).json(waited.result.body);
          return;
        }
      }
      sendInProgress(res);
      return;
    }

    // Try to become the leader for this key.
    const acquired = await acquireLock(key);
    if (!acquired) {
      // Another request holds the lock; wait for its result.
      const waited = await waitForCompletion(key, requestHash);
      if (waited) {
        if (waited.requestHash !== requestHash) {
          sendConflict(res);
          return;
        }
        if (waited.result) {
          res.status(waited.result.status).json(waited.result.body);
          return;
        }
      }
      sendInProgress(res);
      return;
    }

    // Re-check after acquiring the lock (double-checked locking).
    const rechecked = await readRecord(key);
    if (rechecked) {
      await releaseLock(key);
      if (rechecked.requestHash !== requestHash) {
        sendConflict(res);
        return;
      }
      if (rechecked.result) {
        res.status(rechecked.result.status).json(rechecked.result.body);
        return;
      }
      sendInProgress(res);
      return;
    }

    const inFlight: IdempotencyRecord = {
      state: 'in_flight',
      requestHash,
      wallet,
      operation,
      startedAt: Date.now(),
    };
    await writeRecord(key, inFlight, ttlSeconds);

    // Capture the handler's response so we can persist it.
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);
    let captured = false;

    const persist = async (status: number, body: unknown): Promise<void> => {
      if (captured) return;
      captured = true;
      const result: StoredResult = {
        status,
        body,
        requestHash,
        wallet,
        operation,
        completedAt: Date.now(),
      };
      const completed: IdempotencyRecord = {
        state: 'completed',
        requestHash,
        wallet,
        operation,
        result,
        startedAt: inFlight.startedAt,
      };
      try {
        await writeRecord(key, completed, ttlSeconds);
      } finally {
        await releaseLock(key);
      }
    };

    res.json = ((body: unknown) => {
      void persist(res.statusCode, body);
      return originalJson(body);
    }) as Response['json'];

    res.send = ((body: unknown) => {
      // Only persist JSON-ish payloads; fall back to raw body otherwise.
      void persist(res.statusCode, body);
      return originalSend(body);
    }) as Response['send'];

    // Ensure the lock is released if the handler errors before responding.
    res.on('close', () => {
      if (!captured) {
        void releaseLock(key);
      }
    });

    next();
  };
}

/**
 * Poll for a completed record for the given key. Returns the record when it
 * completes (or when its hash differs, so the caller can reject), otherwise
 * null after the wait budget elapses.
 */
async function waitForCompletion(
  key: string,
  requestHash: string,
): Promise<IdempotencyRecord | null> {
  const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
  while (Date.now() < deadline) {
    const record = await readRecord(key);
    if (record) {
      if (record.requestHash !== requestHash) {
        return record;
      }
      if (record.state === 'completed') {
        return record;
      }
    }
    await sleep(IN_FLIGHT_POLL_MS);
  }
  return null;
}

export default idempotencyMiddleware;