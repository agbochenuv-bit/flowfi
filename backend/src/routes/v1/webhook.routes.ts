/**
 * Webhook subscription management routes (Issue #1189)
 */
import { Router } from "express";
import * as webhookController from "../../controllers/webhook.controller.js";

const router = Router();

/**
 * @openapi
 * /v1/webhooks:
 *   post:
 *     summary: Register a new webhook subscription
 *     description: Creates a webhook subscription. The returned `secretKey` is only shown once.
 *     tags: [Webhooks]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userAddress
 *               - targetUrl
 *               - eventTypes
 *             properties:
 *               userAddress:
 *                 type: string
 *                 description: Stellar public key
 *               targetUrl:
 *                 type: string
 *                 format: uri
 *               eventTypes:
 *                 type: array
 *                 items:
 *                   type: string
 *                   enum: [CREATED, TOPPED_UP, WITHDRAWN, CANCELLED, COMPLETED, PAUSED, RESUMED, FEE_COLLECTED]
 *     responses:
 *       201:
 *         description: Webhook created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 subscription:
 *                   $ref: '#/components/schemas/WebhookSubscription'
 *                 secretKey:
 *                   type: string
 *                   description: Webhook signing secret (returned only once)
 *                 message:
 *                   type: string
 *       400:
 *         description: Missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/", webhookController.createWebhook);

/**
 * @openapi
 * /v1/webhooks:
 *   get:
 *     summary: List all webhooks for authenticated user
 *     tags: [Webhooks]
 *     parameters:
 *       - in: query
 *         name: userAddress
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of webhook subscriptions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 subscriptions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/WebhookSubscription'
 *       400:
 *         description: Missing userAddress
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/", webhookController.listWebhooks);

/**
 * @openapi
 * /v1/webhooks/{id}:
 *   delete:
 *     summary: Delete a webhook subscription
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: userAddress
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Webhook deleted successfully
 *       400:
 *         description: Invalid id or missing userAddress
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.delete("/:id", webhookController.deleteWebhook);

/**
 * @openapi
 * /v1/webhooks/{id}:
 *   patch:
 *     summary: Update a webhook subscription
 *     description: |
 *       Updates mutable fields of a webhook subscription (targetUrl, eventTypes, active).
 *       The caller must own the subscription; ownership is verified against `userAddress`.
 *       Disabled subscriptions do not receive deliveries until re-enabled.
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userAddress
 *             properties:
 *               userAddress:
 *                 type: string
 *               targetUrl:
 *                 type: string
 *                 format: uri
 *               eventTypes:
 *                 type: array
 *                 items:
 *                   type: string
 *               active:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Webhook updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 subscription:
 *                   $ref: '#/components/schemas/WebhookSubscription'
 *       400:
 *         description: Invalid id, missing userAddress, or invalid fields
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Caller does not own the subscription
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Webhook not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.patch("/:id", webhookController.updateWebhook);

/**
 * @openapi
 * /v1/webhooks/{id}/secret:
 *   post:
 *     summary: Regenerate a webhook signing secret
 *     description: Rotates the signing secret. The new `secretKey` is returned only once.
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userAddress
 *             properties:
 *               userAddress:
 *                 type: string
 *     responses:
 *       200:
 *         description: Secret regenerated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 secretKey:
 *                   type: string
 *       400:
 *         description: Invalid id or missing userAddress
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Caller does not own the subscription
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Webhook not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/:id/secret", webhookController.regenerateSecret);

/**
 * @openapi
 * /v1/webhooks/{id}/deliveries:
 *   get:
 *     summary: List delivery audit history for a webhook
 *     description: |
 *       Returns the delivery audit history for the subscription, newest first.
 *       Each entry records the delivery status (e.g. `SUCCESS`, `FAILED`), attempt
 *       count, and timestamps. Successful deliveries are never resent by replay.
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: userAddress
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: status
 *         required: false
 *         schema:
 *           type: string
 *           enum: [PENDING, SUCCESS, FAILED]
 *       - in: query
 *         name: limit
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 50
 *       - in: query
 *         name: offset
 *         required: false
 *         schema:
 *           type: integer
 *           minimum: 0
 *           default: 0
 *     responses:
 *       200:
 *         description: Delivery audit history
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 deliveries:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                       eventType:
 *                         type: string
 *                       status:
 *                         type: string
 *                         enum: [PENDING, SUCCESS, FAILED]
 *                       attempts:
 *                         type: integer
 *                       lastAttemptAt:
 *                         type: string
 *                         format: date-time
 *                       createdAt:
 *                         type: string
 *                         format: date-time
 *                 total:
 *                   type: integer
 *       400:
 *         description: Invalid id or missing userAddress
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Caller does not own the subscription
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Webhook not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.get("/:id/deliveries", webhookController.listDeliveries);

/**
 * @openapi
 * /v1/webhooks/{id}/disable:
 *   post:
 *     summary: Disable a webhook subscription
 *     description: |
 *       Disables the subscription so no further deliveries are attempted. The
 *       subscription record and its delivery audit history are retained; use
 *       `PATCH /v1/webhooks/{id}` with `active: true` to re-enable it.
 *       The caller must own the subscription.
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userAddress
 *             properties:
 *               userAddress:
 *                 type: string
 *     responses:
 *       200:
 *         description: Webhook disabled successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 subscription:
 *                   $ref: '#/components/schemas/WebhookSubscription'
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid id or missing userAddress
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Caller does not own the subscription
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Webhook not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Webhook is already disabled
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/:id/disable", webhookController.disableWebhook);

/**
 * @openapi
 * /v1/webhooks/{id}/replay:
 *   post:
 *     summary: Replay failed deliveries for a webhook
 *     description: |
 *       Re-enqueues failed deliveries for the subscription. Only deliveries whose
 *       status is `FAILED` are replayed; successful deliveries are never resent.
 *       The replay window is bounded: only deliveries created within the last
 *       `windowHours` hours (default 24, maximum 168) are eligible, and at most
 *       `limit` deliveries (default 50, maximum 100) are replayed per request.
 *       This endpoint is rate limited per subscription; exceeding the limit
 *       returns `429` with a `Retry-After` header. The caller must own the
 *       subscription.
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userAddress
 *             properties:
 *               userAddress:
 *                 type: string
 *               windowHours:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 168
 *                 default: 24
 *                 description: Only failed deliveries created within this window are replayed
 *               limit:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 100
 *                 default: 50
 *                 description: Maximum number of failed deliveries to replay
 *               deliveryIds:
 *                 type: array
 *                 maxItems: 100
 *                 items:
 *                   type: string
 *                 description: Optional explicit subset of failed delivery ids to replay
 *     responses:
 *       202:
 *         description: Replay accepted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 replayed:
 *                   type: integer
 *                   description: Number of failed deliveries re-enqueued
 *                 skipped:
 *                   type: integer
 *                   description: Number of requested deliveries skipped (not failed, out of window, or over limit)
 *                 deliveryIds:
 *                   type: array
 *                   items:
 *                     type: string
 *                 message:
 *                   type: string
 *       400:
 *         description: Invalid id, missing userAddress, or out-of-bounds replay parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Caller does not own the subscription
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Webhook not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       409:
 *         description: Webhook is disabled; re-enable it before replaying deliveries
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       429:
 *         description: Replay rate limit exceeded
 *         headers:
 *           Retry-After:
 *             schema:
 *               type: integer
 *             description: Seconds until another replay may be attempted
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/:id/replay", webhookReplayRateLimiter, webhookController.replayDeliveries);

/**
 * @openapi
 * /v1/webhooks/{id}/test:
 *   post:
 *     summary: Send a test ping to a webhook
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - userAddress
 *             properties:
 *               userAddress:
 *                 type: string
 *     responses:
 *       200:
 *         description: Test webhook sent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: Test webhook sent
 *                 result:
 *                   type: object
 *                   additionalProperties: true
 *       400:
 *         description: Missing id or userAddress
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
router.post("/:id/test", webhookController.testWebhook);

export default router;
