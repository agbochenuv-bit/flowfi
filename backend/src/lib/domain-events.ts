import { Prisma } from '@prisma/client';
import { EventEmitter } from 'events';

/**
 * Domain events emitted by the API after the underlying database transaction
 * has successfully committed.
 *
 * Cache invalidation (and any other side effect that must not run for rolled
 * back writes) is driven exclusively through these events. Emitting only after
 * commit guarantees that:
 *
 *   - A rolled back transaction never invalidates a cache entry, so readers
 *     cannot observe a cache miss that would be repopulated from a value that
 *     was never persisted.
 *   - A committed transaction always invalidates the affected cache entries,
 *     so subsequent reads observe the new state.
 *
 * Handlers MUST be idempotent. Duplicate events (e.g. the same summary being
 * invalidated twice within a request) are safe because the cache operations
 * they perform (`cache.del`) are naturally idempotent.
 */

export type DomainEvent =
  | UserSummaryInvalidated
  | UserProfileInvalidated;

export interface UserSummaryInvalidated {
  type: 'user.summary.invalidated';
  publicKey: string;
  reason: string;
}

export interface UserProfileInvalidated {
  type: 'user.profile.invalidated';
  publicKey: string;
  reason: string;
}

export type DomainEventHandler = (event: DomainEvent) => void | Promise<void>;

/**
 * In-process emitter for committed domain events.
 *
 * This is intentionally process-local: cache invalidation targets the same
 * process's cache. If the cache is shared across processes, handlers should
 * publish to the shared invalidation channel instead.
 */
class DomainEventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    // Cache invalidation handlers are cheap; avoid noisy max-listener warnings
    // when many modules subscribe during tests.
    this.emitter.setMaxListeners(50);
  }

  subscribe(handler: DomainEventHandler): () => void {
    this.emitter.on('event', handler);
    return () => {
      this.emitter.off('event', handler);
    };
  }

  emit(event: DomainEvent): void {
    this.emitter.emit('event', event);
  }
}

export const domainEvents = new DomainEventBus();

/**
 * Transaction-scoped queue of events that should be emitted once the
 * surrounding transaction commits.
 *
 * We key the queue off the `Prisma.TransactionClient` instance so that nested
 * helpers sharing the same transaction client accumulate events into the same
 * queue, and so that concurrent transactions never see each other's events.
 */
const pendingByTransaction = new WeakMap<
  Prisma.TransactionClient,
  DomainEvent[]
>();

/**
 * Events emitted outside of any transaction. These are flushed immediately by
 * `emitAfterCommit` when no transaction client is supplied, but are also
 * tracked here so that `flushPendingEvents()` can drain anything left over in
 * tests.
 */
let pendingUntransacted: DomainEvent[] = [];

/**
 * Register a domain event to be emitted after the surrounding transaction
 * commits.
 *
 * - When `tx` is provided, the event is queued on that transaction and only
 *   emitted if the transaction commits successfully (see `runInTransaction`).
 * - When `tx` is omitted, the event is emitted immediately. This is only safe
 *   for callers that are not inside a transaction (e.g. read-only paths or
 *   already-committed work).
 */
export function emitAfterCommit(
  event: DomainEvent,
  tx?: Prisma.TransactionClient,
): void {
  if (tx) {
    const queue = pendingByTransaction.get(tx);
    if (queue) {
      queue.push(event);
      return;
    }
    // A transaction client we did not create via `runInTransaction`. We cannot
    // observe its commit, so fall back to emitting immediately to preserve
    // invalidation correctness. Callers should prefer `runInTransaction`.
    domainEvents.emit(event);
    return;
  }

  pendingUntransacted.push(event);
  flushUntransacted();
}

function flushUntransacted(): void {
  if (pendingUntransacted.length === 0) return;
  const events = pendingUntransacted;
  pendingUntransacted = [];
  for (const event of events) {
    domainEvents.emit(event);
  }
}

/**
 * Run `fn` inside a Prisma transaction and emit any events registered via
 * `emitAfterCommit(event, tx)` only after the transaction commits.
 *
 * If `fn` throws (or the transaction rolls back), the queued events are
 * discarded and never emitted. This is the core guarantee that cache
 * invalidation never runs for writes that were not persisted.
 *
 * @example
 *   await runInTransaction(prisma, async (tx) => {
 *     await tx.user.update({ ... });
 *     emitAfterCommit({ type: 'user.summary.invalidated', publicKey, reason: 'update' }, tx);
 *   });
 */
export async function runInTransaction<T>(
  prisma: { $transaction: PrismaClientTransaction },
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  let queued: DomainEvent[] = [];

  let result: T;
  try {
    result = await prisma.$transaction(async (tx) => {
      // Register the queue for this transaction client before invoking `fn`
      // so that nested `emitAfterCommit` calls accumulate here.
      pendingByTransaction.set(tx, queued);
      try {
        return await fn(tx);
      } finally {
        // Detach the queue from the client; the transaction is done either
        // way and we no longer want to accept events for it.
        pendingByTransaction.delete(tx);
      }
    });
  } catch (err) {
    // Transaction rolled back: discard queued events.
    queued = [];
    throw err;
  }

  // Transaction committed: emit queued events. Handlers are idempotent, so
  // duplicate events are safe.
  const events = queued;
  queued = [];
  for (const event of events) {
    domainEvents.emit(event);
  }

  return result;
}

type PrismaClientTransaction = <T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) => Promise<T>;

/**
 * Flush any events that were queued outside of a transaction. Intended for
 * tests to drain leftover state between cases.
 *
 * Note: events queued inside a transaction are owned by that transaction and
 * are flushed by `runInTransaction` on commit; this function does not touch
 * them.
 */
export function flushPendingEvents(): void {
  flushUntransacted();
}

/**
 * Test-only helper: clear all pending untransacted events without emitting
 * them. Use between tests to guarantee isolation.
 */
export function resetPendingEvents(): void {
  pendingUntransacted = [];
}