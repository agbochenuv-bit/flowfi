import { Router } from 'express';
import {
  optionalAuthWithScope,
  requireAuth,
  requireScope,
} from '../../middleware/auth.js';
import {
  createStream,
  listStreams,
  batchReadStreams,
  getChainFreshness,
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
 *     summary: List and search streams with normalized filter semantics
 *     description: |
 *       Returns a paginated list of streams with normalized search (`q` / `search`),
 *       participant (`participant` / `address`), sender, recipient, multi-status
 *       (`status=active,paused`), token (`token` / `tokenAddress`), and time-range
 *       filters, plus canonical `appliedFilters` and explicit chain `freshness`
 *       metadata.
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string, maxLength: 128 }
 *         description: Normalized search term matching streamId or sender/recipient/token substring
 *       - in: query
 *         name: sender
 *         schema: { type: string }
 *       - in: query
 *         name: recipient
 *         schema: { type: string }
 *       - in: query
 *         name: participant
 *         schema: { type: string }
 *         description: Match streams where the address is either sender or recipient (alias `address`)
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Single or comma-separated statuses (`active`, `paused`, `cancelled`, `completed`)
 *       - in: query
 *         name: token
 *         schema: { type: string }
 *         description: Token contract address (alias `tokenAddress`)
 *       - in: query
 *         name: startTimeFrom
 *         schema: { type: integer }
 *       - in: query
 *         name: startTimeTo
 *         schema: { type: integer }
 *       - in: query
 *         name: endTimeFrom
 *         schema: { type: integer }
 *       - in: query
 *         name: endTimeTo
 *         schema: { type: integer }
 *       - in: query
 *         name: createdAfter
 *         schema: { type: string }
 *       - in: query
 *         name: createdBefore
 *         schema: { type: string }
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [createdAt, startTime, lastUpdateTime, depositedAmount, endTime, streamId] }
 *       - in: query
 *         name: order
 *         schema: { type: string, enum: [asc, desc] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, minimum: 0 }
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: cursor
 *         schema: { type: string }
 *       - in: query
 *         name: network
 *         schema: { type: string, enum: [testnet, mainnet] }
 *     responses:
 *       200:
 *         description: Paginated stream list with appliedFilters and chain freshness metadata
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/StreamListResponse'
 *       400:
 *         description: Invalid or conflicting query parameters
 *       401:
 *         description: Invalid, expired, or revoked API credential
 *       403:
 *         description: API credential lacks `streams:read` scope
 *       409:
 *         description: Requested network does not match configured indexer network
 */
router.get('/', optionalAuthWithScope('streams:read'), listStreams);

/**
 * @openapi
 * /v1/streams/freshness:
 *   get:
 *     tags: [Streams]
 *     summary: Inspect chain freshness and finality metadata
 *     description: |
 *       Exposes explicit indexer freshness, ledger lag, verified checkpoint
 *       status, finality classification, and operator/client recovery guidance.
 *       Also sets `X-Chain-*` response headers for lightweight monitoring.
 *     parameters:
 *       - in: query
 *         name: includeNetworkTip
 *         schema: { type: boolean, default: true }
 *       - in: query
 *         name: network
 *         schema: { type: string, enum: [testnet, mainnet] }
 *     responses:
 *       200:
 *         description: Explicit chain freshness and finality metadata
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ChainFreshness'
 *       401:
 *         description: Invalid, expired, or revoked API credential
 *       403:
 *         description: API credential lacks `streams:read` scope
 *       409:
 *         description: Requested network does not match configured indexer network
 */
router.get('/freshness', optionalAuthWithScope('streams:read'), getChainFreshness);

/**
 * @openapi
 * /v1/streams/batch-read:
 *   post:
 *     tags: [Streams]
 *     summary: Bounded multi-stream read endpoint
 *     description: |
 *       Fetches up to 50 streams in a single bounded database query, preserving
 *       deduplicated caller order and returning explicit per-item status
 *       (`found`, `not_found`, `error`), `missingStreamIds`, `failedStreamIds`,
 *       optional claimable calculations, and chain freshness metadata.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/BatchStreamReadRequest'
 *     responses:
 *       200:
 *         description: Bounded multi-stream read result
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/BatchStreamReadResponse'
 *       400:
 *         description: Invalid streamIds or batch size exceeded (max 50)
 *       401:
 *         description: Invalid, expired, or revoked API credential
 *       403:
 *         description: API credential lacks `streams:read` scope
 *       409:
 *         description: Requested network does not match configured indexer network
 *       503:
 *         description: Indexed stream store temporarily unavailable (retryable)
 */
router.post('/batch-read', optionalAuthWithScope('streams:read'), batchReadStreams);

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
 *
 *       An optional customer-defined payment policy may be evaluated before the
 *       stream is prepared by supplying `policyId`. Policy evaluation is a
 *       server-side business-rule boundary only; it does not replace or imply
 *       on-chain authorization, which remains the wallet's responsibility.
 *       Policy results are deterministic for a given input and policy version.
 *       If the policy service does not respond within the configured timeout,
 *       the outcome depends on the policy's `failureMode`: `closed` (default)
 *       rejects the request, `open` allows it and records the timeout in the
 *       audit trail.
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
 *         description: |
 *           Forbidden, or the referenced payment policy denied the request.
 *           Policy denials include `code: POLICY_DENIED` and the audit fields
 *           `policyId`, `policyVersion`, `decision`, and `evaluatedAt`.
 *       409:
 *         description: On-chain state mismatch
 *       422:
 *         description: |
 *           The payment policy could not be evaluated (for example an unknown
 *           `policyId`, an invalid policy definition, or a fail-closed timeout).
 *           The response includes `code: POLICY_EVALUATION_FAILED` and the audit
 *           fields `policyId`, `decision`, `reason`, and `evaluatedAt`.
 */
router.post('/', requireAuth, requireScope('streams:write'), createStream);

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
router.get('/:streamId', optionalAuthWithScope('streams:read'), getStream);

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
router.get('/:streamId/events', optionalAuthWithScope('streams:read'), getStreamEvents);

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
router.get('/:streamId/claimable', optionalAuthWithScope('streams:read'), getStreamClaimableAmount);

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
router.post('/:streamId/top-up', requireAuth, requireScope('streams:write'), topUpStreamHandler);

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
router.post('/:streamId/pause', requireAuth, requireScope('streams:write'), pauseStream);

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
router.post('/:streamId/resume', requireAuth, requireScope('streams:write'), resumeStream);

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
router.post('/:streamId/cancel', requireAuth, requireScope('streams:write'), cancelStreamHandler);

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
router.post('/:streamId/withdraw', requireAuth, requireScope('streams:write'), withdrawHandler);

export default router;
