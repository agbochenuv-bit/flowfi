import type { Response } from 'express';
import { prisma } from '../../lib/prisma.js';
import logger from '../../logger.js';
import * as sorobanService from '../../services/sorobanService.js';
import type { AuthenticatedRequest } from '../../types/auth.types.js';
import * as streamRepository from '../../repositories/stream.repository.js';
import { parseStreamId } from '../../lib/stream-id.js';
import { sendApiError } from '../../types/api-error.js';
import {
  getIdempotencyContext,
  runIdempotentCommand,
  type IdempotencyContext,
} from '../../lib/idempotency.js';

/**
 * @openapi
 * /v1/streams/{streamId}/cancel:
 *   post:
 *     tags:
 *       - Streams
 *     summary: Cancel an active payment stream
 *     description: |
 *       Cancels an active payment stream on the Stellar network.
 *       Only the original sender can cancel the stream.
 *       Accrued tokens are sent to the recipient, and the remainder is refunded to the sender.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema:
 *           type: integer
 *         description: On-chain stream ID
 *     responses:
 *       200:
 *         description: Stream cancelled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 txHash:
 *                   type: string
 *                 status:
 *                   type: string
 *                   example: CANCELLED
 *       403:
 *         description: Forbidden - only sender can cancel
 *       404:
 *         description: Stream not found
 *       409:
 *         description: Stream already cancelled or completed
 */
export const cancelStreamHandler = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const streamIdParam = req.params.streamId;
    const callerAddress = req.user.publicKey;

    const streamId = Array.isArray(streamIdParam) ? streamIdParam[0] : streamIdParam;
    if (!streamId) {
      return sendApiError(res, 400, 'MISSING_STREAM_ID', 'Missing streamId parameter');
    }

    const parsedStreamId = parseStreamId(streamId);
    if (parsedStreamId === null) {
      return sendApiError(res, 400, 'INVALID_STREAM_ID', 'Invalid streamId parameter');
    }

    // 1. Fetch stream from DB
    const stream = await prisma.stream.findUnique({
      where: { streamId: parsedStreamId }
    });

    if (!stream) {
      return sendApiError(res, 404, 'NOT_FOUND', 'Stream not found');
    }

    // 2. Validate caller is sender
    if (stream.sender !== callerAddress) {
      return sendApiError(res, 403, 'FORBIDDEN', 'Only the sender can cancel the stream');
    }

    // 3. Check status
    if (!stream.isActive) {
      return sendApiError(res, 409, 'CONFLICT', 'Stream is already cancelled or completed');
    }

    // 4. Validate request payload before touching the idempotency store
    const senderSecret = req.body?.senderSecret;
    if (typeof senderSecret !== 'string' || senderSecret.length === 0) {
      return sendApiError(res, 400, 'INVALID_REQUEST', 'senderSecret is required');
    }

    // 5. Resolve the idempotency context (if the client supplied a key).
    //    The context binds the key to the wallet, operation and request hash.
    let idempotencyContext: IdempotencyContext | null;
    try {
      idempotencyContext = await getIdempotencyContext(req, {
        wallet: callerAddress,
        operation: 'stream.cancel',
        request: { streamId: parsedStreamId },
      });
    } catch (idempotencyError) {
      if (idempotencyError instanceof Error && idempotencyError.name === 'IdempotencyConflictError') {
        return sendApiError(
          res,
          422,
          'IDEMPOTENCY_KEY_REUSED',
          'Idempotency key was reused with a different request payload',
        );
      }
      throw idempotencyError;
    }

    // 6. Execute the command at most once. On retry with the same key the stored
    //    result is returned instead of submitting another on-chain transaction.
    const { result } = await runIdempotentCommand(
      idempotencyContext,
      async () => {
        const txHash = await sorobanService.cancelStream(parsedStreamId, senderSecret);

        // Update DB record status using repository helper
        await streamRepository.updateStatus(parsedStreamId, 'CANCELLED');

        logger.info(
          `[CancelStream] Stream ${parsedStreamId} cancelled by ${callerAddress}. Tx: ${txHash}`,
        );

        return { txHash, status: 'CANCELLED' as const };
      },
    );

    return res.status(200).json(result);
  } catch (error) {
    logger.error('Error cancelling stream:', error);
    if (error instanceof Error && error.message.includes('Simulation failed')) {
        return sendApiError(res, 400, 'TRANSACTION_SIMULATION_FAILED', error.message);
    }
    return sendApiError(res, 500, 'INTERNAL_SERVER_ERROR', 'A technical error occurred. Please try again later.');
  }
};
