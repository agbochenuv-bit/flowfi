/**
 * Workers registry
 *
 * Exports a single `startWorkers` function that is called from the main server
 * entry-point after the database connection is confirmed healthy.
 */

import { sorobanEventWorker } from "./soroban-event-worker.js";
import { startStreamRunwayWorker } from "./stream-runway-worker.js";
import logger from "../logger.js";

let runwayWorkerTimer: NodeJS.Timeout | null = null;

export async function startWorkers(): Promise<void> {
  logger.info("[Workers] Starting background workers...");
  // The soroban event worker acquires its poll-ownership lease as part of
  // start(). If another replica currently owns the lease, the worker will
  // not poll until ownership is acquired (or recovered after owner loss).
  await sorobanEventWorker.start();

  // Start stream runway alert worker (Issue #1190)
  runwayWorkerTimer = startStreamRunwayWorker();
}

export async function stopWorkers(): Promise<void> {
  // Best-effort lease release so a graceful restart hands ownership over
  // immediately rather than waiting for the lease TTL to expire.
  try {
    await sorobanEventWorker.stop();
  } catch (err) {
    logger.warn(
      { err },
      "[Workers] Failed to release soroban event worker lease during shutdown",
    );
  }

  if (runwayWorkerTimer) {
    clearInterval(runwayWorkerTimer);
    runwayWorkerTimer = null;
    logger.info("[Workers] Stream runway worker stopped");
  }
}