/**
 * Webhook subscription management routes (Issue #1189)
 *
 * Authorization (Issue #71): every route requires an authenticated wallet.
 * The owning wallet is derived from the authenticated principal
 * (`req.auth.address`) rather than trusting client-supplied `userAddress`
 * query/body values. Requests that reference another wallet's subscription
 * are rejected with 403 and never leak subscription identifiers.
 *
 * Validation (Issue #68): path/query/body inputs are validated centrally via
 * `validateRequest`; failures return a 400 with a normalized error shape.
 */
import { Router } from "express";
import { z } from "zod";
import * as webhookController from "../../controllers/webhook.controller.js";
import { requireAuth } from "../../middleware/auth.middleware.js";
import { validateRequest } from "../../middleware/validateRequest.middleware.js";

const router = Router();

const stellarAddress = z
  .string()
  .trim()
  .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar public key");

const idParamSchema = z.object({
  id: z.string().trim().min(1, "Webhook id is required"),
});

const listQuerySchema = z.object({
  userAddress: stellarAddress.optional(),
});

const deleteQuerySchema = z.object({
  userAddress: stellarAddress.optional(),
});

const createBodySchema = z.object({
  userAddress: stellarAddress.optional(),
  targetUrl: z.string().trim().url("targetUrl must be a valid URL"),
  eventTypes: z
    .array(
      z.enum([
        "CREATED",
        "TOPPED_UP",
        "WITHDRAWN",
        "CANCELLED",
        "COMPLETED",
        "PAUSED",
        "RESUMED",
        "FEE_COLLECTED",
      ]),
    )
    .min(1, "At least one event type is required"),
});

const updateBodySchema = z
  .object({
    userAddress: stellarAddress.optional(),
    targetUrl: z.string().trim().url("targetUrl must be a valid URL").optional(),
    eventTypes: z
      .array(
        z.enum([
          "CREATED",
          "TOPPED_UP",
          "WITHDRAWN",
          "CANCELLED",
          "COMPLETED",
          "PAUSED",
          "RESUMED",
          "FEE_COLLECTED",
        ]),
      )
      .min(1, "At least one event type is required")
      .optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).some((key) => key !== "userAddress"), {
    message: "At least one field must be provided",
  });

const testBodySchema = z.object({
  userAddress: stellarAddress.optional(),
});

/**
 * Overrides any client-supplied `userAddress` with the authenticated wallet so
 * controllers always scope lookups/mutations to the caller's own data.
 */
const bindAuthenticatedWallet = (
  req: Parameters<typeof requireAuth>[0],
  _res: Parameters<typeof requireAuth>[1],
  next: Parameters<typeof requireAuth>[2],
) => {
  const address = req.auth?.address;
  if (address) {
    req.query = { ...req.query, userAddress: address };
    if (req.body && typeof req.body === "object") {
      req.body.userAddress = address;
    }
  }
  next();
};

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
 *         description: Invalid payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Authenticated wallet does not own the resource
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
router.post(
  "/",
  requireAuth,
  validateRequest({ body: createBodySchema }),
  bindAuthenticatedWallet,
  webhookController.createWebhook,
);

/**
 * @openapi
 * /v1/webhooks:
 *   get:
 *     summary: List all webhooks for authenticated user
 *     tags: [Webhooks]
 *     description: Lists subscriptions owned by the authenticated wallet. Any client-supplied `userAddress` is ignored.
 *     parameters:
 *       - in: query
 *         name: userAddress
 *         required: false
 *         description: Deprecated; ignored in favor of the authenticated wallet.
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of webhook subscriptions owned by the caller
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
 *         description: Invalid query parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing or invalid authentication
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
router.get(
  "/",
  requireAuth,
  validateRequest({ query: listQuerySchema }),
  bindAuthenticatedWallet,
  webhookController.listWebhooks,
);

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
 *         required: false
 *         description: Deprecated; ignored in favor of the authenticated wallet.
 *         schema:
 *           type: string
 *     responses:
 *       204:
 *         description: Webhook deleted successfully
 *       400:
 *         description: Invalid id or query parameters
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Subscription belongs to another wallet
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Subscription not found
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
router.delete(
  "/:id",
  requireAuth,
  validateRequest({ params: idParamSchema, query: deleteQuerySchema }),
  bindAuthenticatedWallet,
  webhookController.deleteWebhook,
);

/**
 * @openapi
 * /v1/webhooks/{id}:
 *   patch:
 *     summary: Update a webhook subscription owned by the authenticated wallet
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Webhook updated successfully
 *       400:
 *         description: Invalid id or payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Subscription belongs to another wallet
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Subscription not found
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
router.patch(
  "/:id",
  requireAuth,
  validateRequest({ params: idParamSchema, body: updateBodySchema }),
  bindAuthenticatedWallet,
  webhookController.updateWebhook,
);

/**
 * @openapi
 * /v1/webhooks/{id}/secret:
 *   post:
 *     summary: Regenerate the signing secret for a webhook owned by the authenticated wallet
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Secret regenerated successfully
 *       400:
 *         description: Invalid id
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Subscription belongs to another wallet
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Subscription not found
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
router.post(
  "/:id/secret",
  requireAuth,
  validateRequest({ params: idParamSchema }),
  bindAuthenticatedWallet,
  webhookController.regenerateSecret,
);

/**
 * @openapi
 * /v1/webhooks/{id}/deliveries:
 *   get:
 *     summary: List delivery attempts for a webhook owned by the authenticated wallet
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of delivery attempts
 *       400:
 *         description: Invalid id
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Subscription belongs to another wallet
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Subscription not found
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
router.get(
  "/:id/deliveries",
  requireAuth,
  validateRequest({ params: idParamSchema }),
  bindAuthenticatedWallet,
  webhookController.listDeliveries,
);

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
 *             properties:
 *               userAddress:
 *                 type: string
 *                 description: Deprecated; ignored in favor of the authenticated wallet.
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
 *         description: Invalid id or payload
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing or invalid authentication
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       403:
 *         description: Subscription belongs to another wallet
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       404:
 *         description: Subscription not found
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
router.post(
  "/:id/test",
  requireAuth,
  validateRequest({ params: idParamSchema, body: testBodySchema }),
  bindAuthenticatedWallet,
  webhookController.testWebhook,
);

export default router;
