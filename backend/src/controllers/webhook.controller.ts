/**
 * Webhook Controller (Issue #1189)
 */
import type { Request, Response } from "express";
import * as webhookService from "../services/webhook.service.js";
import logger from "../logger.js";

const ALLOWED_EVENT_TYPES: readonly string[] = [
  "stream.created",
  "stream.updated",
  "stream.cancelled",
  "stream.completed",
  "withdrawal.created",
  "withdrawal.completed",
];

function mapWebhookError(error: any, res: Response, fallback: string): void {
  const status = Number(error?.statusCode ?? error?.status);
  if (status === 400 || status === 403 || status === 404 || status === 409) {
    res.status(status).json({ error: error.message || fallback });
    return;
  }
  if (error?.code === "NOT_FOUND") {
    res.status(404).json({ error: error.message || fallback });
    return;
  }
  if (error?.code === "FORBIDDEN" || error?.code === "UNAUTHORIZED") {
    res.status(403).json({ error: error.message || fallback });
    return;
  }
  if (error?.code === "CONFLICT" || error?.code === "DISABLED") {
    res.status(409).json({ error: error.message || fallback });
    return;
  }
  if (error?.code === "VALIDATION") {
    res.status(400).json({ error: error.message || fallback });
    return;
  }
  logger.error("[Webhook Controller] Unexpected error:", error);
  res.status(500).json({ error: fallback });
}

export async function createWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { userAddress, targetUrl, eventTypes } = req.body;

    if (!userAddress || !targetUrl || !Array.isArray(eventTypes)) {
      res.status(400).json({
        error: "Missing required fields: userAddress, targetUrl, eventTypes",
      });
      return;
    }

    if (eventTypes.length === 0) {
      res.status(400).json({ error: "eventTypes must not be empty" });
      return;
    }

    const invalidEventTypes = eventTypes.filter(
      (eventType: unknown) =>
        typeof eventType !== "string" ||
        !ALLOWED_EVENT_TYPES.includes(eventType),
    );
    if (invalidEventTypes.length > 0) {
      res.status(400).json({
        error: `Unsupported eventTypes: ${invalidEventTypes.join(", ")}`,
        allowedEventTypes: ALLOWED_EVENT_TYPES,
      });
      return;
    }

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
  } catch (error: any) {
    logger.error("[Webhook Controller] Create error:", error);
    res
      .status(500)
      .json({ error: error.message || "Failed to create webhook" });
  }
}

export async function listWebhooks(req: Request, res: Response): Promise<void> {
  try {
    const { userAddress } = req.query;

    if (!userAddress || typeof userAddress !== "string") {
      res.status(400).json({ error: "userAddress query parameter required" });
      return;
    }

    const subscriptions =
      await webhookService.listWebhookSubscriptions(userAddress);

    // Don't expose secret keys
    const safeSubscriptions = subscriptions.map(
      ({ secretKey, ...rest }) => rest,
    );

    res.json({ subscriptions: safeSubscriptions });
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
    const { userAddress } = req.query;

    if (!id || !userAddress || typeof userAddress !== "string") {
      res.status(400).json({ error: "Invalid id or userAddress required" });
      return;
    }

    await webhookService.deleteWebhookSubscription(id, userAddress);

    res.status(204).send();
  } catch (error: any) {
    logger.error("[Webhook Controller] Delete error:", error);
    res.status(500).json({ error: "Failed to delete webhook" });
  }
}

export async function updateWebhook(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { userAddress } = req.query;
    if (!id || typeof userAddress !== "string") {
      res.status(400).json({ error: "id and userAddress are required" });
      return;
    }

    if (req.body?.eventTypes !== undefined) {
      const eventTypes = req.body.eventTypes;
      if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
        res.status(400).json({ error: "eventTypes must be a non-empty array" });
        return;
      }
      const invalidEventTypes = eventTypes.filter(
        (eventType: unknown) =>
          typeof eventType !== "string" ||
          !ALLOWED_EVENT_TYPES.includes(eventType),
      );
      if (invalidEventTypes.length > 0) {
        res.status(400).json({
          error: `Unsupported eventTypes: ${invalidEventTypes.join(", ")}`,
          allowedEventTypes: ALLOWED_EVENT_TYPES,
        });
        return;
      }
    }

    const subscription = await webhookService.updateWebhookSubscription(id, userAddress, req.body);
    res.json(subscription);
  } catch (error: any) {
    mapWebhookError(error, res, "Failed to update webhook");
  }
}

export async function disableWebhook(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { userAddress } = req.query;
    if (!id || typeof userAddress !== "string") {
      res.status(400).json({ error: "id and userAddress are required" });
      return;
    }

    const subscription = await webhookService.disableWebhookSubscription(id, userAddress);
    const { secretKey, ...safeSubscription } = subscription;
    res.json({ subscription: safeSubscription });
  } catch (error: any) {
    mapWebhookError(error, res, "Failed to disable webhook");
  }
}

export async function replayDeliveries(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { userAddress } = req.query;
    if (!id || typeof userAddress !== "string") {
      res.status(400).json({ error: "id and userAddress are required" });
      return;
    }

    const { deliveryIds, limit } = req.body ?? {};
    if (deliveryIds !== undefined && !Array.isArray(deliveryIds)) {
      res.status(400).json({ error: "deliveryIds must be an array" });
      return;
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit <= 0)) {
      res.status(400).json({ error: "limit must be a positive integer" });
      return;
    }

    const audit = await webhookService.replayFailedDeliveries(id, userAddress, {
      deliveryIds,
      limit,
    });
    res.status(202).json({ replay: audit });
  } catch (error: any) {
    mapWebhookError(error, res, "Failed to replay webhook deliveries");
  }
}

export async function listDeliveries(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { userAddress, page = "1", limit = "20" } = req.query;
    if (!id || typeof userAddress !== "string") {
      res.status(400).json({ error: "id and userAddress are required" });
      return;
    }
    res.json(await webhookService.listWebhookDeliveries(id, userAddress, Number(page), Number(limit)));
  } catch (error: any) {
    res.status(400).json({ error: error.message || "Failed to list webhook deliveries" });
  }
}

export async function regenerateSecret(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { userAddress } = req.body;
    if (!id || !userAddress) {
      res.status(400).json({ error: "id and userAddress are required" });
      return;
    }
    res.json({ secretKey: await webhookService.regenerateWebhookSecret(id, userAddress) });
  } catch (error: any) {
    res.status(400).json({ error: error.message || "Failed to regenerate webhook secret" });
  }
}

export async function testWebhook(req: Request, res: Response): Promise<void> {
  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const { userAddress } = req.body;

    if (!id || !userAddress) {
      res.status(400).json({ error: "id and userAddress required" });
      return;
    }

    const result = await webhookService.sendTestWebhook(id, userAddress);

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
