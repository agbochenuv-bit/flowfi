import type { Response } from 'express';
import { prisma } from '../../../lib/prisma.js';
import logger from '../../../logger.js';
import { claimableAmountService } from '../../../services/claimable.service.js';
import { withdraw as sorobanWithdraw } from '../../../services/sorobanService.js';
import type { AuthenticatedRequest } from '../../../types/auth.types.js';
import { parseStreamId } from '../../../lib/stream-id.js';
import { sendApiError } from '../../../types/api-error.js';
import { sendStreamVersionConflict } from '../../../lib/stream-version.js';
import { streamRepository } from '../../../repositories/stream.repository.js';

/**
 * @openapi
 * /v1/streams/{streamId}/withdraw:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Withdraw claimable balance from a payment stream
 *     description: Withdraws the currently claimable amount. Only the recipient can withdraw.
 *       Clients may submit the stream version they reviewed via `expectedVersion`; if the
 *       stream has changed since then the request is rejected with a 409 conflict carrying
 *       the current version metadata. The withdrawal itself is still signed by the wallet.
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema:
 *           type: integer
 *         description: On-chain stream ID
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               expectedVersion:
 *                 type: integer
 *                 description: Stream version the client reviewed; omit to skip the check
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Withdrawal submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/WithdrawResponse'
 *       400:
 *         description: Invalid streamId, invalid expectedVersion, or contract revert
 *       401:
 *         description: Unauthorized - missing or invalid authentication
 *       403:
 *         description: Forbidden - caller is not the stream recipient
 *       404:
 *         description: Stream not found
 *       409:
 *         description: Conflict - no claimable balance available, or stale expectedVersion
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StreamVersionConflict'
 *       500:
 *         description: Internal server error
 */
export const withdrawHandler = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const streamIdParam = Array.isArray(req.params.streamId)
      ? req.params.streamId[0]
      : req.params.streamId;
    const parsedStreamId = parseStreamId(streamIdParam);

    if (parsedStreamId === null) {
      return sendApiError(res, 400, 'INVALID_STREAM_ID', 'Invalid streamId parameter');
    }

    const rawExpectedVersion = (req.body as { expectedVersion?: unknown } | undefined)?.expectedVersion;
    let expectedVersion: number | undefined;
    if (rawExpectedVersion !== undefined && rawExpectedVersion !== null) {
      if (
        typeof rawExpectedVersion !== 'number' ||
        !Number.isInteger(rawExpectedVersion) ||
        rawExpectedVersion < 0
      ) {
        return sendApiError(
          res,
          400,
          'INVALID_EXPECTED_VERSION',
          'expectedVersion must be a non-negative integer',
        );
      }
      expectedVersion = rawExpectedVersion;
    }

    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId },
      select: {
        streamId: true,
        sender: true,
        recipient: true,
        tokenAddress: true,
        ratePerSecond: true,
        depositedAmount: true,
        withdrawnAmount: true,
        startTime: true,
        lastUpdateTime: true,
        isActive: true,
        isPaused: true,
        pausedAt: true,
        totalPausedDuration: true,
        updatedAt: true,
        version: true,
      },
    });

    if (!stream) {
      return sendApiError(res, 404, 'NOT_FOUND', 'Stream not found');
    }

    if (expectedVersion !== undefined && stream.version !== expectedVersion) {
      return sendStreamVersionConflict(res, parsedStreamId, stream.version);
    }

    // Verify the caller is the stream recipient
    if (stream.recipient !== req.user.publicKey) {
      return sendApiError(res, 403, 'FORBIDDEN', 'Only the stream recipient can withdraw from the stream');
    }

    const claimable = claimableAmountService.getClaimableAmount(stream);

    if (!claimable.actionable) {
      return sendApiError(res, 409, 'CONFLICT', 'No claimable balance is currently available');
    }

    try {
      // Call Soroban service
      const result = await sorobanWithdraw(parsedStreamId, req.user.publicKey);
      
      const now = BigInt(Math.floor(Date.now() / 1000));
      const withdrawAmount = BigInt(claimable.claimableAmount);

      // Use raw SQL atomic increment to prevent concurrent withdraw requests
      // from losing updates (Issue #1217 — read-compute-write race).
      // Prisma's built-in { increment } is unavailable on String-typed columns,
      // so we use $transaction with $executeRawUnsafe for atomic SQL updates.
      const updatedStream = await prisma.$transaction(async (tx) => {
        // Atomically increment withdrawnAmount in a single SQL statement so
        // concurrent requests compound rather than overwrite each other.
        await tx.$executeRawUnsafe(
          `UPDATE "Stream" SET "withdrawnAmount" = ("withdrawnAmount"::bigint + $1::bigint)::text, "lastUpdateTime" = $2 WHERE "streamId" = $3`,
          withdrawAmount.toString(),
          now,
          parsedStreamId,
        );

        // Re-read the stream to get post-increment values.
        const refreshed = await tx.stream.findUnique({
          where: { streamId: parsedStreamId },
        });

        // Conditionally deactivate if fully withdrawn.
        if (
          stream.isActive &&
          refreshed &&
          BigInt(refreshed.withdrawnAmount) >= BigInt(refreshed.depositedAmount)
        ) {
          await tx.stream.update({
            where: { streamId: parsedStreamId },
            data: { isActive: false },
          });
          refreshed.isActive = false;
        }

        return refreshed;
      });

      // Create or update a WITHDRAWN event
      await prisma.streamEvent.upsert({
        where: {
          transactionHash_eventType: {
            transactionHash: result.txHash,
            eventType: 'WITHDRAWN',
          },
        },
        create: {
          streamId: parsedStreamId,
          eventType: 'WITHDRAWN',
          amount: claimable.claimableAmount,
          transactionHash: result.txHash,
          ledgerSequence: 0,
          timestamp: now,
          metadata: JSON.stringify({ withdrawnBy: req.user.publicKey }),
        },
        update: {},
      });

      // Bump the stream version with a compare-and-set so concurrent mutations
      // that reviewed the same version are rejected rather than silently applied.
      const versionBumped = await streamRepository.compareAndSetVersion(
        parsedStreamId,
        stream.version,
        stream.version + 1,
      );

      if (!versionBumped) {
        const current = await prisma.stream.findUnique({
          where: { streamId: parsedStreamId },
          select: { version: true },
        });
        logger.warn(
          `Stream ${parsedStreamId} version changed concurrently during withdraw by ${req.user.publicKey}`,
        );
        return sendStreamVersionConflict(res, parsedStreamId, current?.version ?? stream.version);
      }

      logger.info(`Stream ${parsedStreamId} withdrawn by ${req.user.publicKey}`);

      return res.status(200).json({
        success: true,
        streamId: parsedStreamId,
        txHash: result.txHash,
        amount: claimable.claimableAmount,
        version: stream.version + 1,
        stream: updatedStream,
      });
    } catch (sorobanError) {
      logger.error(`Soroban withdraw failed for stream ${parsedStreamId}:`, sorobanError);
      return sendApiError(res, 400, 'WITHDRAWAL_FAILED', 'Failed to withdraw from stream on chain');
    }
  } catch (error) {
    logger.error('Error withdrawing from stream:', error);
    return sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'A technical error occurred. Please try again later.');
  }
};
