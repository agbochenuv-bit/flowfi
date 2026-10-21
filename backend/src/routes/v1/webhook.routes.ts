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
 *     responses:
 *       201:
 *         description: Webhook subscription created; secret key returned once
 *       400:
 *         description: Missing required fields
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
 *     responses:
 *       200:
 *         description: Updated webhook subscription
 *       400:
 *         description: Invalid request
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
