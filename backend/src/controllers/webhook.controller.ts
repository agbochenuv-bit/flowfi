/**
 * Webhook Controller (Issue #1189)
 */
import type { Request, Response } from "express";
import * as webhookService from "../services/webhook.service.js";
import logger from "../logger.js";
import { ApiError } from "../errors/ApiError.js";
import { ErrorCode } from "../errors/errorCodes.js";
import { sendErrorEnvelope } from "../errors/errorEnvelope.js";

function respondWithError(req: Request, res: Response, error: unknown): void {
  if (error instanceof ApiError) {
    sendErrorEnvelope(req, res, error);
    return;
  }
  logger.error("[Webhook Controller] Unexpected error:", error);
  sendErrorEnvelope(
    req,
    res,
    new ApiError(
      ErrorCode.INTERNAL_ERROR,
      500,
      "An unexpected error occurred",
    ),
  );
}

export async function createWebhook(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { userAddress, targetUrl, eventTypes } = req.body;

    if (!userAddress || !targetUrl || !Array.isArray(eventTypes)) {
      sendErrorEnvelope(
        req,
        res,
        new ApiError(
          ErrorCode.VALIDATION_FAILED,
          400,
          "Missing required fields: userAddress, targetUrl, eventTypes",
          [
            { field: "userAddress", issue: "required" },
            { field: "targetUrl", issue: "required" },
            { field: "eventTypes", issue: "must be an array" },
          ].filter((detail) => {
            if (detail.field === "userAddress") return !userAddress;
            if (detail.field === "targetUrl") return !targetUrl;
            return !Array.isArray(eventTypes);
          }),
        ),
      );
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
    respondWithError(req, res, error);
  }
}

export async function listWebhooks(req: Request, res: Response): Promise<void> {
  try {
    const { userAddress } = req.query;

    if (!userAddress || typeof userAddress !== "string") {
      sendErrorEnvelope(
        req,
        res,
        new ApiError(
          ErrorCode.VALIDATION_FAILED,
          400,
          "userAddress query parameter required",
          [{ field: "userAddress", issue: "required" }],
        ),
      );
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
    respondWithError(req, res, error);
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
      sendErrorEnvelope(
        req,
        res,
        new ApiError(
          ErrorCode.VALIDATION_FAILED,
          400,
          "Invalid id or userAddress required",
          [
            { field: "id", issue: "required" },
            { field: "userAddress", issue: "required" },
          ].filter((detail) =>
            detail.field === "id" ? !id : typeof userAddress !== "string",
          ),
        ),
      );
      return;
    }

    await webhookService.deleteWebhookSubscription(id, userAddress);

    res.status(204).send();
  } catch (error: any) {
    respondWithError(req, res, error);
  }
}

export async function updateWebhook(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { userAddress } = req.query;
    if (!id || typeof userAddress !== "string") {
      sendErrorEnvelope(
        req,
        res,
        new ApiError(
          ErrorCode.VALIDATION_FAILED,
          400,
          "id and userAddress are required",
          [
            { field: "id", issue: "required" },
            { field: "userAddress", issue: "required" },
          ].filter((detail) =>
            detail.field === "id" ? !id : typeof userAddress !== "string",
          ),
        ),
      );
      return;
    }
    const subscription = await webhookService.updateWebhookSubscription(id, userAddress, req.body);
    res.json(subscription);
  } catch (error: any) {
    respondWithError(req, res, error);
  }
}

export async function listDeliveries(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { userAddress, page = "1", limit = "20" } = req.query;
    if (!id || typeof userAddress !== "string") {
      sendErrorEnvelope(
        req,
        res,
        new ApiError(
          ErrorCode.VALIDATION_FAILED,
          400,
          "id and userAddress are required",
          [
            { field: "id", issue: "required" },
            { field: "userAddress", issue: "required" },
          ].filter((detail) =>
            detail.field === "id" ? !id : typeof userAddress !== "string",
          ),
        ),
      );
      return;
    }
    res.json(await webhookService.listWebhookDeliveries(id, userAddress, Number(page), Number(limit)));
  } catch (error: any) {
    respondWithError(req, res, error);
  }
}

export async function regenerateSecret(req: Request, res: Response): Promise<void> {
  try {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const { userAddress } = req.body;
    if (!id || !userAddress) {
      sendErrorEnvelope(
        req,
        res,
        new ApiError(
          ErrorCode.VALIDATION_FAILED,
          400,
          "id and userAddress are required",
          [
            { field: "id", issue: "required" },
            { field: "userAddress", issue: "required" },
          ].filter((detail) =>
            detail.field === "id" ? !id : !userAddress,
          ),
        ),
      );
      return;
    }
    res.json({ secretKey: await webhookService.regenerateWebhookSecret(id, userAddress) });
  } catch (error: any) {
    respondWithError(req, res, error);
  }
}

export async function testWebhook(req: Request, res: Response): Promise<void> {
  try {
    const idParam = req.params.id;
    const id = Array.isArray(idParam) ? idParam[0] : idParam;
    const { userAddress } = req.body;

    if (!id || !userAddress) {
      sendErrorEnvelope(
        req,
        res,
        new ApiError(
          ErrorCode.VALIDATION_FAILED,
          400,
          "id and userAddress required",
          [
            { field: "id", issue: "required" },
            { field: "userAddress", issue: "required" },
          ].filter((detail) =>
            detail.field === "id" ? !id : !userAddress,
          ),
        ),
      );
      return;
    }

    const result = await webhookService.sendTestWebhook(id, userAddress);

    res.json({
      message: "Test webhook sent",
      result,
    });
  } catch (error: any) {
    respondWithError(req, res, error);
  }
}
