import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { createSseTicket, subscribe } from '../../controllers/sse.controller.js';

const router = Router();

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
