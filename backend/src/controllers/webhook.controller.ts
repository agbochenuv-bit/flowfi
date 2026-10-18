/**
 * Webhook Controller (Issue #1189)
 */
import type { Request, Response } from "express";
import * as webhookService from "../services/webhook.service.js";
import logger from "../logger.js";
import type { AuthenticatedRequest } from "../types/auth.types.js";

function getAuthenticatedAddress(req: Request): string {
  return (req as AuthenticatedRequest).user.publicKey;
}

export async function createWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { targetUrl, eventTypes } = req.body;

    if (!targetUrl || !Array.isArray(eventTypes)) {
      res.status(400).json({
        error: "Missing required fields: targetUrl, eventTypes",
      });
      return;
    }

    const subscription = await webhookService.createWebhookSubscription(
      getAuthenticatedAddress(req),
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
  } catch (error: any) {
    logger.error("[Webhook Controller] Create error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to create webhook" });
  }
}

export async function listWebhooks(req: Request, res: Response): Promise<void> {
  try {
    const subscriptions =
      await webhookService.listWebhookSubscriptions(getAuthenticatedAddress(req));

    res.json({ subscriptions });
  } catch (error: any) {
    logger.error("[Webhook Controller] List error:", error);
    res.status(500).json({ error: "Failed to list webhooks" });
  }
}

export async function deleteWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!id) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    await webhookService.deleteWebhookSubscription(id, getAuthenticatedAddress(req));

    res.status(204).send();
  } catch (error: any) {
    logger.error("[Webhook Controller] Delete error:", error);
    res.status(500).json({ error: "Failed to delete webhook" });
  }
}

export async function updateWebhook(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const subscription = await webhookService.updateWebhookSubscription(id, getAuthenticatedAddress(req), req.body);
    res.json(subscription);
  } catch (error: any) {
    res.status(400).json({ error: error.message || "Failed to update webhook" });
  }
}

export async function listDeliveries(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { page = "1", limit = "20" } = req.query;
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    res.json(await webhookService.listWebhookDeliveries(id, getAuthenticatedAddress(req), Number(page), Number(limit)));
  } catch (error: any) {
    res.status(400).json({ error: error.message || "Failed to list webhook deliveries" });
  }
}

export async function regenerateSecret(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    res.json({ secretKey: await webhookService.regenerateWebhookSecret(id, getAuthenticatedAddress(req)) });
  } catch (error: any) {
    res.status(400).json({ error: error.message || "Failed to regenerate webhook secret" });
  }
}

export async function testWebhook(req: Request, res: Response): Promise<void> {
  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    if (!id) {
      res.status(400).json({ error: "id required" });
      return;
    }

    const result = await webhookService.sendTestWebhook(id, getAuthenticatedAddress(req));

    res.json({
      message: "Test webhook sent",
      result,
    });
  } catch (error: any) {
    logger.error("[Webhook Controller] Test error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to send test webhook" });
  }
}
