/**
 * Workers registry
 *
 * Exports a single `startWorkers` function that is called from the main server
 * entry-point after the database connection is confirmed healthy.
 */

import { sorobanEventWorker } from "./soroban-event-worker.js";
import { startStreamRunwayWorker } from "./stream-runway-worker.js";
import {
  purgeExpiredAlertHistory,
  purgeExpiredWebhookDeliveries,
} from "../services/webhook.service.js";
import logger from "../logger.js";

let runwayWorkerTimer: NodeJS.Timeout | null = null;
let webhookRetentionTimer: NodeJS.Timeout | null = null;
const WEBHOOK_RETENTION_INTERVAL_MS = 60 * 60 * 1000;

// Shared shutdown signal. Aborted on SIGTERM/SIGINT so long-running workers
// can stop acquiring new work and abandon in-flight batches safely.
const shutdownController = new AbortController();
let signalHandlersInstalled = false;
let shutdownRequested = false;

function requestShutdown(signal: NodeJS.Signals): void {
  if (shutdownRequested) return;
  shutdownRequested = true;
  logger.info(
    `[Workers] Received ${signal}; requesting graceful shutdown of background workers`,
  );
  shutdownController.abort();
}

function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  process.once("SIGTERM", () => requestShutdown("SIGTERM"));
  process.once("SIGINT", () => requestShutdown("SIGINT"));
}

/**
 * Returns the shared shutdown signal. Workers should check
 * `signal.aborted` before acquiring new work and pass it to cancellable
 * operations (RPC fetch, DB persistence) so an in-flight batch can be
 * abandoned without advancing the checkpoint.
 */
export function getShutdownSignal(): AbortSignal {
  return shutdownController.signal;
}

async function runWebhookRetention(): Promise<void> {
  if (shutdownController.signal.aborted) return;
  try {
    const [deletedDeliveries, deletedAlerts] = await Promise.all([
      purgeExpiredWebhookDeliveries(),
      purgeExpiredAlertHistory(),
    ]);
    if (deletedDeliveries > 0 || deletedAlerts > 0) {
      logger.info(
        `[Retention] Deleted ${deletedDeliveries} expired webhook deliveries and ${deletedAlerts} alert records`,
      );
    }
  } catch (error) {
    logger.warn("[WebhookRetention] Delivery cleanup failed", error);
  }
}

export async function startWorkers(): Promise<void> {
  logger.info("[Workers] Starting background workers...");
  installSignalHandlers();
  // The soroban event worker acquires its poll-ownership lease as part of
  // start(). If another replica currently owns the lease, the worker will
  // not poll until ownership is acquired (or recovered after owner loss).
  await sorobanEventWorker.start();

  // Start stream runway alert worker (Issue #1190)
  runwayWorkerTimer = startStreamRunwayWorker();

  void runWebhookRetention();
  webhookRetentionTimer = setInterval(
    () => void runWebhookRetention(),
    WEBHOOK_RETENTION_INTERVAL_MS,
  );
}

export async function stopWorkers(): Promise<void> {
  // Signal cancellation first so the poll loop stops acquiring new ranges
  // and any in-flight batch is abandoned without advancing the checkpoint.
  if (!shutdownController.signal.aborted) {
    shutdownController.abort();
  }

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

  if (webhookRetentionTimer) {
    clearInterval(webhookRetentionTimer);
    webhookRetentionTimer = null;
    logger.info("[Workers] Webhook retention worker stopped");
  }
}
