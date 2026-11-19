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
import { getStreamReadinessHandler } from '../../controllers/stream/readiness.js';
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
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StreamListResponse'
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
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Stream'
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
 * /v1/streams/{streamId}/readiness:
 *   get:
 *     tags: [Streams]
 *     summary: Preflight readiness checks for common stream actions
 *     description: |
 *       Returns machine-readable readiness results for the actions available on
 *       a stream (cancel, withdraw, top-up, pause, resume). Each check carries a
 *       stable `code` and a `severity` of `blocker` or `warning`.
 *
 *       This is a best-effort preflight only. Results reflect state at the time
 *       of the request and do NOT guarantee that a subsequent transaction will
 *       succeed: the stream may change between this check and execution (for
 *       example a concurrent cancel, a pause, or a balance change). Clients
 *       should submit the returned `version` as `expectedVersion` on mutations
 *       and handle `409 STREAM_VERSION_CONFLICT` by re-running readiness.
 *
 *       Readiness never authorizes a transaction; wallet signatures and
 *       on-chain validation remain the source of truth.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: streamId
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Readiness report
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StreamReadinessResponse'
 *       400:
 *         description: Invalid streamId
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Stream not found
 */
router.get('/:streamId/readiness', requireAuth, getStreamReadinessHandler);

/**
 * @openapi
 * /v1/streams/{streamId}/top-up:
 *   post:
 *     tags: [Streams]
 *     summary: Add tokens to a running stream
 *     description: |
 *       Optionally accepts `expectedVersion` (the stream `version` the client
 *       reviewed). If provided and the stream has changed since, the request is
 *       rejected with `409 STREAM_VERSION_CONFLICT` and the current version
 *       metadata. The wallet signature is still required and validated
 *       independently; a matching version does not authorize the mutation.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/StreamMutationRequest'
 *     responses:
 *       200:
 *         description: Stream topped up
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Stream not found
 *       409:
 *         description: Stale stream version (STREAM_VERSION_CONFLICT)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StreamVersionConflict'
 */
router.post('/:streamId/top-up', requireAuth, topUpStreamHandler);

/**
 * @openapi
 * /v1/streams/{streamId}/pause:
 *   post:
 *     tags: [Streams]
 *     summary: Pause a running stream
 *     description: |
 *       Optionally accepts `expectedVersion`. A stale version is rejected with
 *       `409 STREAM_VERSION_CONFLICT`; wallet authorization is still enforced.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/StreamMutationRequest'
 *     responses:
 *       200:
 *         description: Stream paused
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Stream not found
 *       409:
 *         description: Stale stream version (STREAM_VERSION_CONFLICT)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StreamVersionConflict'
 */
router.post('/:streamId/pause', requireAuth, pauseStream);

/**
 * @openapi
 * /v1/streams/{streamId}/resume:
 *   post:
 *     tags: [Streams]
 *     summary: Resume a paused stream
 *     description: |
 *       Optionally accepts `expectedVersion`. A stale version is rejected with
 *       `409 STREAM_VERSION_CONFLICT`; wallet authorization is still enforced.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/StreamMutationRequest'
 *     responses:
 *       200:
 *         description: Stream resumed
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Stream not found
 *       409:
 *         description: Stale stream version (STREAM_VERSION_CONFLICT)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StreamVersionConflict'
 */
router.post('/:streamId/resume', requireAuth, resumeStream);

/**
 * @openapi
 * /v1/streams/{streamId}/cancel:
 *   post:
 *     tags: [Streams]
 *     summary: Cancel an active stream
 *     description: |
 *       Optionally accepts `expectedVersion`. A stale version is rejected with
 *       `409 STREAM_VERSION_CONFLICT`; wallet authorization is still enforced.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/StreamMutationRequest'
 *     responses:
 *       200:
 *         description: Stream cancelled
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Stream not found
 *       409:
 *         description: Stale stream version (STREAM_VERSION_CONFLICT)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StreamVersionConflict'
 */
router.post('/:streamId/cancel', requireAuth, cancelStreamHandler);

/**
 * @openapi
 * /v1/streams/{streamId}/withdraw:
 *   post:
 *     tags: [Streams]
 *     summary: Withdraw claimable balance from a stream
 *     description: |
 *       Optionally accepts `expectedVersion`. A stale version is rejected with
 *       `409 STREAM_VERSION_CONFLICT`; wallet authorization is still enforced.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/StreamMutationRequest'
 *     responses:
 *       200:
 *         description: Withdrawal recorded
 *       400:
 *         description: Validation error
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: Stream not found
 *       409:
 *         description: Stale stream version (STREAM_VERSION_CONFLICT)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StreamVersionConflict'
 */
router.post('/:streamId/withdraw', requireAuth, withdrawHandler);

export default router;
