/**
 * Stream Runway & Low-Balance Alert Engine (Issue #1190)
 * Monitors active streams and generates proactive notifications before funds run out
 */
import { prisma } from "../lib/prisma.js";
import logger from "../logger.js";
import { claimableAmountService } from "../services/claimable.service.js";
import { sseService } from "../services/sse.service.js";

const WARNING_THRESHOLD_HOURS = 48;
const CRITICAL_THRESHOLD_HOURS = 24;
const DEDUPLICATION_WINDOW_HOURS = 24;

interface RunwayCalculation {
  streamId: bigint;
  remainingRunwaySeconds: number;
  unclaimedBalance: bigint;
  claimableNow: bigint;
  sender: string;
  recipient: string;
}

/**
 * Calculate remaining runway for a stream in seconds
 */
function calculateStreamRunway(stream: any, now: number): RunwayCalculation {
  const result = claimableAmountService.getClaimableAmount(
    {
      streamId: stream.streamId,
      tokenAddress: stream.tokenAddress,
      ratePerSecond: stream.ratePerSecond,
      depositedAmount: stream.depositedAmount,
      withdrawnAmount: stream.withdrawnAmount,
      startTime: stream.startTime,
      lastUpdateTime: stream.lastUpdateTime,
      isActive: stream.isActive,
      isPaused: stream.isPaused,
      pausedAt: stream.pausedAt,
      totalPausedDuration: stream.totalPausedDuration,
    },
    now,
  );

  const claimableNow = BigInt(result.claimableAmount);
  const unclaimedBalance =
    BigInt(stream.depositedAmount) - BigInt(stream.withdrawnAmount);
  const remainingBalance = unclaimedBalance - claimableNow;
  const ratePerSecond = BigInt(stream.ratePerSecond);

  let remainingRunwaySeconds = 0;
  if (ratePerSecond > 0n && remainingBalance > 0n) {
    remainingRunwaySeconds = Number(remainingBalance / ratePerSecond);
  }

  return {
    streamId: stream.streamId,
    remainingRunwaySeconds,
    unclaimedBalance,
    claimableNow,
    sender: stream.sender,
    recipient: stream.recipient,
  };
}

/**
 * Compute the deterministic deduplication window start for a given time.
 * Time is floored to the DEDUPLICATION_WINDOW_HOURS bucket so that restarts,
 * clock skew, and parallel replicas all resolve to the same window key.
 */
function getWindowStart(nowMs: number): Date {
  const windowMs = DEDUPLICATION_WINDOW_HOURS * 60 * 60 * 1000;
  return new Date(Math.floor(nowMs / windowMs) * windowMs);
}

/**
 * Attempt to claim an alert for the given (streamId, alertType, windowStart).
 * Returns true only if this call created the row (i.e. the alert should be
 * emitted). A Prisma P2002 unique-constraint violation means another worker
 * (or a previous run) already claimed this window, so we return false.
 */
async function claimAlert(
  streamId: bigint,
  alertType: string,
  windowStart: Date,
): Promise<boolean> {
  try {
    await prisma.alertHistory.create({
      data: {
        streamId,
        alertType,
        windowStart,
      },
    });
    return true;
  } catch (error: any) {
    if (error?.code === "P2002") {
      return false;
    }
    throw error;
  }
}

/**
 * Send low balance alert via SSE and webhooks
 */
async function sendLowBalanceAlert(
  runway: RunwayCalculation,
  alertType: "WARNING_48H" | "CRITICAL_24H",
): Promise<void> {
  const hoursRemaining = runway.remainingRunwaySeconds / 3600;

  const alertData = {
    streamId: runway.streamId.toString(),
    alertType,
    remainingRunwaySeconds: runway.remainingRunwaySeconds,
    hoursRemaining: Math.floor(hoursRemaining * 10) / 10,
    unclaimedBalance: runway.unclaimedBalance.toString(),
    sender: runway.sender,
    recipient: runway.recipient,
    timestamp: new Date().toISOString(),
  };

  // Send SSE notification to sender
  sseService.broadcastToUser(runway.sender, "STREAM_LOW_BALANCE", alertData);

  // Send SSE notification to recipient (informational)
  sseService.broadcastToUser(runway.recipient, "STREAM_LOW_BALANCE", alertData);

  // Broadcast to stream subscribers
  sseService.broadcastToStream(
    runway.streamId.toString(),
    "STREAM_LOW_BALANCE",
    alertData,
  );

  logger.info(
    `[RunwayWorker] ${alertType} alert sent for stream ${runway.streamId}: ${hoursRemaining.toFixed(1)}h remaining`,
  );
}

/**
 * Main worker function - runs every hour.
 *
 * Externally observable behavior:
 * - Each stream/policy (WARNING_48H, CRITICAL_24H) emits at most one alert per
 *   deduplication window. The window is derived by flooring the current time to
 *   the DEDUPLICATION_WINDOW_HOURS bucket, so restarts, clock skew, and parallel
 *   replicas converge on the same (streamId, alertType, windowStart) key.
 * - SSE broadcasts only fire when the alert row is actually inserted, so
 *   concurrent workers never double-emit.
 * - The optional `clock` parameter (defaults to `() => Date.now()`) allows tests
 *   to control time deterministically.
 */
export async function runStreamRunwayCheck(
  clock: () => number = () => Date.now(),
): Promise<void> {
  const startTime = clock();
  logger.info("[RunwayWorker] Starting runway check...");

  try {
    // Fetch all active, unpaused streams
    const activeStreams = await prisma.stream.findMany({
      where: {
        isActive: true,
        isPaused: false,
      },
    });

    logger.info(
      `[RunwayWorker] Checking ${activeStreams.length} active streams`,
    );

    const nowMs = clock();
    const now = Math.floor(nowMs / 1000);
    const windowStart = getWindowStart(nowMs);
    let warningsSent = 0;
    let criticalsSent = 0;

    for (const stream of activeStreams) {
      try {
        const runway = calculateStreamRunway(stream, now);

        // Check critical threshold (24 hours)
        if (runway.remainingRunwaySeconds <= CRITICAL_THRESHOLD_HOURS * 3600) {
          const claimed = await claimAlert(
            stream.streamId,
            "CRITICAL_24H",
            windowStart,
          );

          if (claimed) {
            await sendLowBalanceAlert(runway, "CRITICAL_24H");
            criticalsSent++;
          } else {
            logger.info(
              `[RunwayWorker] Skipping CRITICAL_24H for stream ${stream.streamId}: already sent in window ${windowStart.toISOString()}`,
            );
          }
        }
        // Check warning threshold (48 hours)
        else if (
          runway.remainingRunwaySeconds <=
          WARNING_THRESHOLD_HOURS * 3600
        ) {
          const claimed = await claimAlert(
            stream.streamId,
            "WARNING_48H",
            windowStart,
          );

          if (claimed) {
            await sendLowBalanceAlert(runway, "WARNING_48H");
            warningsSent++;
          } else {
            logger.info(
              `[RunwayWorker] Skipping WARNING_48H for stream ${stream.streamId}: already sent in window ${windowStart.toISOString()}`,
            );
          }
        }
      } catch (error) {
        logger.error(
          `[RunwayWorker] Error processing stream ${stream.streamId}:`,
          error,
        );
      }
    }

    const duration = clock() - startTime;
    logger.info(
      `[RunwayWorker] Check complete in ${duration}ms. Warnings: ${warningsSent}, Critical: ${criticalsSent}`,
    );
  } catch (error) {
    logger.error("[RunwayWorker] Fatal error during runway check:", error);
  }
}

/**
 * Start the worker with hourly interval
 */
export function startStreamRunwayWorker(
  clock: () => number = () => Date.now(),
): NodeJS.Timeout {
  const INTERVAL_MS = 60 * 60 * 1000; // 1 hour

  // Run immediately on start
  runStreamRunwayCheck(clock).catch((error) => {
    logger.error("[RunwayWorker] Initial run failed:", error);
  });

  // Schedule hourly runs
  const timer = setInterval(() => {
    runStreamRunwayCheck(clock).catch((error) => {
      logger.error("[RunwayWorker] Scheduled run failed:", error);
    });
  }, INTERVAL_MS);

  logger.info("[RunwayWorker] Worker started - running every hour");

  return timer;
}
