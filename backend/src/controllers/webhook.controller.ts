/**
 * Webhook Controller (Issue #1189)
 *
 * Inputs are validated upstream (see webhook.routes.ts) and the authenticated
 * wallet is attached to the request by the auth middleware. The controller
 * derives the owning wallet from that context instead of trusting
 * client-supplied addresses, and delegates all error mapping to the
 * centralized error handler by throwing ApiError / letting errors propagate.
 */
import type { Request, Response } from "express";
import * as webhookService from "../services/webhook.service.js";
import { ApiError } from "../errors/ApiError.js";
import { getAuthenticatedWallet } from "../middleware/auth.js";

function requireWallet(req: Request): string {
  const wallet = getAuthenticatedWallet(req);
  if (!wallet) {
    throw new ApiError(401, "Authentication required");
  }
  return wallet;
}

function requireId(req: Request): string {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  if (!id) {
    throw new ApiError(400, "Webhook id is required");
  }
  return id;
}

export async function createWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const userAddress = requireWallet(req);
  const { targetUrl, eventTypes } = req.body;

  const subscription = await webhookService.createWebhookSubscription(
    userAddress,
    targetUrl,
    eventTypes,
  );

  // Don't expose the secret key in response
  const { secretKey, ...safeSubscription } = subscription;

  res.status(201).json({
    subscription: safeSubscription,
    secretKey, // Only returned once on creation
    message: "Store the secret key securely - it will not be shown again",
  });
}

export async function listWebhooks(req: Request, res: Response): Promise<void> {
  const userAddress = requireWallet(req);

  const subscriptions =
    await webhookService.listWebhookSubscriptions(userAddress);

  // Don't expose secret keys
  const safeSubscriptions = subscriptions.map(({ secretKey, ...rest }) => rest);

  res.json({ subscriptions: safeSubscriptions });
}

export async function deleteWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  const id = requireId(req);
  const userAddress = requireWallet(req);

  await webhookService.deleteWebhookSubscription(id, userAddress);

  res.status(204).send();
}

export async function updateWebhook(req: Request, res: Response): Promise<void> {
  const id = requireId(req);
  const userAddress = requireWallet(req);

  const subscription = await webhookService.updateWebhookSubscription(
    id,
    userAddress,
    req.body,
  );
  res.json(subscription);
}

export async function listDeliveries(req: Request, res: Response): Promise<void> {
  const id = requireId(req);
  const userAddress = requireWallet(req);
  const { page = "1", limit = "20" } = req.query;

  res.json(
    await webhookService.listWebhookDeliveries(
      id,
      userAddress,
      Number(page),
      Number(limit),
    ),
  );
}

export async function regenerateSecret(req: Request, res: Response): Promise<void> {
  const id = requireId(req);
  const userAddress = requireWallet(req);

  res.json({
    secretKey: await webhookService.regenerateWebhookSecret(id, userAddress),
  });
}

export async function testWebhook(req: Request, res: Response): Promise<void> {
  const id = requireId(req);
  const userAddress = requireWallet(req);

  const result = await webhookService.sendTestWebhook(id, userAddress);

  res.json({
    message: "Test webhook sent",
    result,
  });
}
