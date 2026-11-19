import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import {
  createWebhook,
  listWebhooks,
  deleteWebhook,
  updateWebhook,
  listDeliveries,
  regenerateSecret,
  testWebhook,
  getWebhookHealth,
} from '../../controllers/webhook.controller.js';

const router = Router();

// All webhook routes require authentication
router.use(requireAuth);

/**
 * @openapi
 * /v1/webhooks:
 *   get:
 *     tags: [Webhooks]
 *     summary: List webhook subscriptions
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of webhook subscriptions for the authenticated wallet
 *       401:
 *         description: Unauthorized
 */
router.get('/', listWebhooks);

/**
 * @openapi
 * /v1/webhooks:
 *   post:
 *     tags: [Webhooks]
 *     summary: Create a webhook subscription
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetUrl, eventTypes]
 *             properties:
 *               targetUrl:
 *                 type: string
 *                 format: uri
 *               eventTypes:
 *                 type: array
 *                 items: { type: string }
 *               eventFilters:
 *                 type: array
 *                 description: >-
 *                   Optional list of supported event families to subscribe to.
 *                   When omitted, all supported event families are delivered.
 *                   Unknown or unsupported families are rejected with 400.
 *                 items:
 *                   type: string
 *                   enum: [transaction, wallet, contract, anchor, system]
 *               schemaVersion:
 *                 type: string
 *                 description: Payload schema version used for deliveries.
 *                 enum: [v1]
 *                 default: v1
 *     responses:
 *       201:
 *         description: Webhook subscription created; secret key returned once
 *       400:
 *         description: Missing required fields or invalid eventFilters/schemaVersion
 *       401:
 *         description: Unauthorized
 */
router.post('/', createWebhook);

/**
 * @openapi
 * /v1/webhooks/{id}:
 *   patch:
 *     tags: [Webhooks]
 *     summary: Update a webhook subscription
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               targetUrl:
 *                 type: string
 *                 format: uri
 *               eventTypes:
 *                 type: array
 *                 items: { type: string }
 *               eventFilters:
 *                 type: array
 *                 description: >-
 *                   Optional list of supported event families to subscribe to.
 *                   Unknown or unsupported families are rejected with 400.
 *                 items:
 *                   type: string
 *                   enum: [transaction, wallet, contract, anchor, system]
 *               schemaVersion:
 *                 type: string
 *                 description: Payload schema version used for deliveries.
 *                 enum: [v1]
 *                 default: v1
 *     responses:
 *       200:
 *         description: Updated webhook subscription
 *       400:
 *         description: Invalid request or invalid eventFilters/schemaVersion
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Webhook not found
 */
router.patch('/:id', updateWebhook);

/**
 * @openapi
 * /v1/webhooks/{id}:
 *   delete:
 *     tags: [Webhooks]
 *     summary: Delete a webhook subscription
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204:
 *         description: Webhook deleted
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Webhook not found
 */
router.delete('/:id', deleteWebhook);

/**
 * @openapi
 * /v1/webhooks/{id}/deliveries:
 *   get:
 *     tags: [Webhooks]
 *     summary: List delivery attempts for a webhook
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Delivery history
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Webhook not found
 */
router.get('/:id/deliveries', listDeliveries);

/**
 * @openapi
 * /v1/webhooks/{id}/health:
 *   get:
 *     tags: [Webhooks]
 *     summary: Get delivery health and diagnostics for a webhook
 *     description: >-
 *       Returns sanitized delivery diagnostics for the endpoint, including
 *       current status, last-success time, and failure categories. Response
 *       bodies and signing secrets are never included.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Delivery health for the webhook
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 id:
 *                   type: string
 *                 status:
 *                   type: string
 *                   enum: [healthy, degraded, failing, unknown]
 *                 lastSuccessAt:
 *                   type: string
 *                   format: date-time
 *                   nullable: true
 *                 lastFailureAt:
 *                   type: string
 *                   format: date-time
 *                   nullable: true
 *                 consecutiveFailures:
 *                   type: integer
 *                 lastFailureCategory:
 *                   type: string
 *                   nullable: true
 *                   enum:
 *                     - timeout
 *                     - connection_error
 *                     - tls_error
 *                     - http_4xx
 *                     - http_5xx
 *                     - invalid_response
 *                     - unknown
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Webhook not found
 */
router.get('/:id/health', getWebhookHealth);

/**
 * @openapi
 * /v1/webhooks/{id}/secret:
 *   post:
 *     tags: [Webhooks]
 *     summary: Regenerate the signing secret for a webhook
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: New secret key
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Webhook not found
 */
router.post('/:id/secret', regenerateSecret);

/**
 * @openapi
 * /v1/webhooks/{id}/test:
 *   post:
 *     tags: [Webhooks]
 *     summary: Send a test payload to a webhook
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Test webhook sent
 *       401:
 *         description: Unauthorized
 *       404:
 *         description: Webhook not found
 */
router.post('/:id/test', testWebhook);

export default router;
