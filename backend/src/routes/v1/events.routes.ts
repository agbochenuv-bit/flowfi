import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { createSseTicket, subscribe } from '../../controllers/sse.controller.js';
import {
  listEvents,
  listArchiveBatches,
  verifyArchiveBatch,
  restoreArchiveBatch,
} from '../../controllers/events.controller.js';

const router = Router();

/**
 * @openapi
 * /v1/events:
 *   get:
 *     tags: [Events]
 *     summary: List payment events across the hot and archive boundary
 *     description: |
 *       Returns payment events ordered newest-first. By default only events
 *       still inside the hot retention window are returned.
 *
 *       **Retention policy:** events older than the configured retention
 *       window (`EVENT_RETENTION_DAYS`, default 90) are moved out of the hot
 *       query tables into immutable archive batches. Archived events remain
 *       retrievable by passing `includeArchived=true`; the response then
 *       spans the hot/archive boundary and each item reports its `source`
 *       (`hot` or `archive`).
 *
 *       **Archive integrity:** every archive batch stores a SHA-256 hash over
 *       its ordered event payloads. `GET /v1/admin/events/archive/:batchId/verify`
 *       recomputes the hash and reports any mismatch.
 *
 *       **Safe restore procedure:** to bring archived events back into the
 *       hot tables, first verify the batch, then call
 *       `POST /v1/admin/events/archive/:batchId/restore`. Restore is
 *       idempotent, refuses to run on a batch whose integrity check fails,
 *       and never deletes the archive copy, so it can be re-run safely.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: includeArchived
 *         required: false
 *         schema: { type: boolean, default: false }
 *         description: Include events that have been moved to archive batches
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, minimum: 1, maximum: 500, default: 100 }
 *       - in: query
 *         name: before
 *         required: false
 *         schema: { type: string, format: date-time }
 *         description: Cursor — return events strictly older than this timestamp
 *     responses:
 *       200:
 *         description: Events across the requested boundary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       streamId: { type: string }
 *                       createdAt: { type: string, format: date-time }
 *                       source: { type: string, enum: [hot, archive] }
 *                 nextCursor:
 *                   type: string
 *                   nullable: true
 *       400:
 *         description: Invalid query parameters
 *       401:
 *         description: Unauthorized
 */
router.get('/', requireAuth, listEvents);

/**
 * @openapi
 * /v1/admin/events/archive:
 *   get:
 *     tags: [Events]
 *     summary: List archive batches
 *     description: |
 *       Lists archive batches with their id, event count, time range, and
 *       stored integrity hash. Requires an admin wallet.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: limit
 *         required: false
 *         schema: { type: integer, minimum: 1, maximum: 200, default: 50 }
 *       - in: query
 *         name: before
 *         required: false
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Archive batches
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Caller is not an admin
 */
router.get('/admin/events/archive', requireAuth, listArchiveBatches);

/**
 * @openapi
 * /v1/admin/events/archive/{batchId}/verify:
 *   get:
 *     tags: [Events]
 *     summary: Verify an archive batch integrity hash
 *     description: |
 *       Recomputes the SHA-256 hash over the batch's ordered event payloads
 *       and compares it with the stored hash. Returns `valid: false` with the
 *       expected and actual hashes when the batch has been tampered with or
 *       corrupted. Requires an admin wallet.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: batchId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Verification result
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 batchId: { type: string }
 *                 valid: { type: boolean }
 *                 expectedHash: { type: string }
 *                 actualHash: { type: string }
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Caller is not an admin
 *       404:
 *         description: Batch not found
 */
router.get('/admin/events/archive/:batchId/verify', requireAuth, verifyArchiveBatch);

/**
 * @openapi
 * /v1/admin/events/archive/{batchId}/restore:
 *   post:
 *     tags: [Events]
 *     summary: Restore an archive batch into the hot tables
 *     description: |
 *       Safely restores an archive batch into the hot query tables.
 *
 *       **Procedure:** verify the batch first (see the verify endpoint). The
 *       restore refuses to run when the integrity check fails, so a corrupted
 *       batch can never be reintroduced into hot storage. Restore is
 *       idempotent — events already present in the hot tables are skipped —
 *       and the archive copy is retained, so the operation can be retried.
 *       Requires an admin wallet.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: batchId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Restore summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 batchId: { type: string }
 *                 restored: { type: integer }
 *                 skipped: { type: integer }
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Caller is not an admin
 *       404:
 *         description: Batch not found
 *       409:
 *         description: Batch failed its integrity check and was not restored
 */
router.post('/admin/events/archive/:batchId/restore', requireAuth, restoreArchiveBatch);

/**
 * @openapi
 * /v1/events/ticket:
 *   post:
 *     tags: [Events]
 *     summary: Issue a short-lived SSE subscription ticket
 *     description: |
 *       Issues a signed, short-lived ticket (60 s) that authorises the holder
 *       to open one SSE connection via `GET /v1/events/subscribe`. The ticket
 *       is scoped to the streams and users the authenticated wallet owns.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               streams:
 *                 type: array
 *                 items: { type: string }
 *                 description: Specific stream IDs to subscribe to (max 500)
 *               users:
 *                 type: array
 *                 items: { type: string }
 *                 description: Wallet public keys to subscribe to (max 500)
 *               all:
 *                 type: boolean
 *                 description: Subscribe to all streams owned by the authenticated wallet
 *     responses:
 *       200:
 *         description: Signed SSE ticket
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ticket:
 *                   type: string
 *       400:
 *         description: Invalid subscription parameters
 *       401:
 *         description: Unauthorized
 */
router.post('/ticket', requireAuth, createSseTicket);

/**
 * @openapi
 * /v1/events/subscribe:
 *   get:
 *     tags: [Events]
 *     summary: Open an SSE stream for real-time payment events
 *     description: |
 *       Opens a persistent Server-Sent Events (SSE) connection. Requires a
 *       valid ticket obtained from `POST /v1/events/ticket`. The connection
 *       streams events for the subscriptions encoded in the ticket.
 *
 *       **Note:** This endpoint keeps the connection open; use
 *       `curl -N --no-buffer` or a browser `EventSource` to consume it.
 *     parameters:
 *       - in: query
 *         name: ticket
 *         required: true
 *         schema: { type: string }
 *         description: Signed SSE ticket from POST /v1/events/ticket
 *     responses:
 *       200:
 *         description: SSE stream opened (text/event-stream)
 *         content:
 *           text/event-stream:
 *             schema:
 *               type: string
 *       401:
 *         description: Missing, invalid, or expired ticket
 *       503:
 *         description: Server is shutting down
 */
router.get('/subscribe', subscribe);

export default router;
