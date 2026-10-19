import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  createStream,
  listStreams,
  getStream,
  getStreamEvents,
  getStreamClaimableAmount,
  getUserStreamSummary,
  topUpStreamHandler,
  pauseStream,
  resumeStream,
} from '../../controllers/stream.controller.js';
import { cancelStreamHandler } from '../../controllers/stream/cancel.js';
import { simulateStreamHandler } from '../../controllers/stream/simulate.js';
import { withdrawHandler } from './streams/withdraw.js';

const router = Router();

/**
 * @openapi
 * /v1/streams:
 *   get:
 *     tags: [Streams]
 *     summary: List streams
 *     description: |
 *       Returns a paginated list of streams optionally filtered by sender,
 *       recipient, status, or token address.
 *     parameters:
 *       - in: query
 *         name: sender
 *         schema: { type: string }
 *       - in: query
 *         name: recipient
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, cancelled, completed, paused] }
 *       - in: query
 *         name: token
 *         schema: { type: string }
 *       - in: query
 *         name: sort
 *         schema: { type: string }
 *       - in: query
 *         name: order
 *         schema: { type: string, enum: [asc, desc] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated stream list
 *       400:
 *         description: Invalid query parameters
 */
router.get('/', listStreams);

/**
 * @openapi
 * /v1/streams:
 *   post:
 *     tags: [Streams]
 *     summary: Register an on-chain stream in the backend index
 *     description: |
 *       Creates a DB projection for a stream that has already been confirmed
 *       on-chain. Rejects requests where the provided parameters do not match
 *       the on-chain state.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/CreateStreamRequest'
 *     responses:
 *       201:
 *         description: Stream registered
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       409:
 *         description: On-chain state mismatch
 */
router.post('/', requireAuth, createStream);

/**
 * @openapi
 * /v1/streams/simulate:
 *   post:
 *     tags: [Streams]
 *     summary: Simulate a stream contract call
 */
router.post('/simulate', simulateStreamHandler);

/**
 * @openapi
 * /v1/streams/users/{address}/summary:
 *   get:
 *     tags: [Streams]
 *     summary: Get aggregate stream statistics for a wallet address
 *     parameters:
 *       - in: path
 *         name: address
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: User stream summary
 *       400:
 *         description: Invalid address
 */
router.get('/users/:address/summary', getUserStreamSummary);

/**
 * @openapi
 * /v1/streams/{streamId}:
 *   get:
 *     tags: [Streams]
 *     summary: Get a single stream by ID
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Stream record
 *       400:
 *         description: Invalid streamId
 *       404:
 *         description: Stream not found
 */
router.get('/:streamId', getStream);

/**
 * @openapi
 * /v1/streams/{streamId}/events:
 *   get:
 *     tags: [Streams]
 *     summary: List events for a stream
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *       - in: query
 *         name: order
 *         schema: { type: string, enum: [asc, desc] }
 *       - in: query
 *         name: eventType
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated event list
 *       400:
 *         description: Invalid parameters
 *       404:
 *         description: Stream not found
 */
router.get('/:streamId/events', getStreamEvents);

/**
 * @openapi
 * /v1/streams/{streamId}/claimable:
 *   get:
 *     tags: [Streams]
 *     summary: Get claimable balance for a stream
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: at
 *         schema: { type: integer }
 *         description: Unix timestamp to calculate claimable amount at
 *     responses:
 *       200:
 *         description: Claimable amount
 *       400:
 *         description: Invalid parameters
 *       404:
 *         description: Stream not found
 */
router.get('/:streamId/claimable', getStreamClaimableAmount);

/**
 * @openapi
 * /v1/streams/{streamId}/top-up:
 *   post:
 *     tags: [Streams]
 *     summary: Add tokens to a running stream
 *     security:
 *       - bearerAuth: []
 */
router.post('/:streamId/top-up', requireAuth, topUpStreamHandler);

/**
 * @openapi
 * /v1/streams/{streamId}/pause:
 *   post:
 *     tags: [Streams]
 *     summary: Pause a running stream
 *     security:
 *       - bearerAuth: []
 */
router.post('/:streamId/pause', requireAuth, pauseStream);

/**
 * @openapi
 * /v1/streams/{streamId}/resume:
 *   post:
 *     tags: [Streams]
 *     summary: Resume a paused stream
 *     security:
 *       - bearerAuth: []
 */
router.post('/:streamId/resume', requireAuth, resumeStream);

/**
 * @openapi
 * /v1/streams/{streamId}/cancel:
 *   post:
 *     tags: [Streams]
 *     summary: Cancel an active stream
 *     security:
 *       - bearerAuth: []
 */
router.post('/:streamId/cancel', requireAuth, cancelStreamHandler);

/**
 * @openapi
 * /v1/streams/{streamId}/withdraw:
 *   post:
 *     tags: [Streams]
 *     summary: Withdraw claimable balance from a stream
 *     security:
 *       - bearerAuth: []
 */
router.post('/:streamId/withdraw', requireAuth, withdrawHandler);

export default router;
