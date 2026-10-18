/**
 * Outgoing Webhook Event Dispatcher with HMAC Signature (Issue #1189)
 * Delivers real-time HTTP POST notifications for stream events
 */
import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import logger from "../logger.js";
import { recordAuditEvent } from "./audit.service.js";

export interface WebhookSubscription {
  id: string;
  userAddress: string;
  targetUrl: string;
  secretKey: string;
  previousSecretKey?: string | null;
  previousSecretExpiresAt?: Date | null;
  eventTypes: string[];
  isActive: boolean;
}

export interface WebhookPayload {
  eventType: string;
  data: Record<string, any>;
  timestamp: string;
}

const MAX_RETRY_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [0, 60000, 300000, 900000, 3600000]; // 0, 1m, 5m, 15m, 1h
const SECRET_ROTATION_OVERLAP_MS = 5 * 60 * 1000;
const ENCRYPTED_SECRET_PREFIX = "enc:v1:";

function getWebhookEncryptionKey(): Buffer {
  const raw = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  const key = raw ? Buffer.from(raw, "base64") : Buffer.alloc(0);
  if (key.length !== 32) {
    throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }
  return key;
}

function encryptWebhookSecret(secret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getWebhookEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${ENCRYPTED_SECRET_PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptWebhookSecret(secret: string): string {
  if (!secret.startsWith(ENCRYPTED_SECRET_PREFIX)) return secret;
  const [ivPart, tagPart, dataPart] = secret.slice(ENCRYPTED_SECRET_PREFIX.length).split(":");
  if (!ivPart || !tagPart || !dataPart) throw new Error("Invalid encrypted webhook secret");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    getWebhookEncryptionKey(),
    Buffer.from(ivPart, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataPart, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function safeTargetHost(targetUrl: string): string {
  try {
    return new URL(targetUrl).host;
  } catch {
    return "invalid";
  }
}

/** Encrypt pre-existing plaintext secrets during startup before serving traffic. */
export async function encryptExistingWebhookSecrets(): Promise<void> {
  if (process.env.NODE_ENV === "production") getWebhookEncryptionKey();
  const subscriptions = await prisma.webhookSubscription.findMany({
    select: { id: true, secretKey: true, previousSecretKey: true },
  });
  if (subscriptions.length === 0) return;
  getWebhookEncryptionKey();
  for (const subscription of subscriptions) {
    const secretKey = subscription.secretKey.startsWith(ENCRYPTED_SECRET_PREFIX)
      ? subscription.secretKey
      : encryptWebhookSecret(subscription.secretKey);
    const previousSecretKey = subscription.previousSecretKey &&
      !subscription.previousSecretKey.startsWith(ENCRYPTED_SECRET_PREFIX)
      ? encryptWebhookSecret(subscription.previousSecretKey)
      : subscription.previousSecretKey;
    if (secretKey !== subscription.secretKey || previousSecretKey !== subscription.previousSecretKey) {
      await prisma.webhookSubscription.update({
        where: { id: subscription.id },
        data: { secretKey, previousSecretKey },
      });
    }
  }
}

/**
 * Generate HMAC-SHA256 signature for webhook payload
 */
export function generateWebhookSignature(
  payload: string,
  secret: string,
  timestamp: number,
): string {
  const signaturePayload = `${timestamp}.${payload}`;
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(signaturePayload);
  return hmac.digest("hex");
}

/**
 * Verify webhook signature
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  timestamp: number,
  toleranceSeconds = 300,
): boolean {
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return false;
  }

  const expectedSignature = generateWebhookSignature(
    payload,
    secret,
    timestamp,
  );
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature),
  );
}

/**
 * Create webhook subscription
 */
export async function createWebhookSubscription(
  userAddress: string,
  targetUrl: string,
  eventTypes: string[],
): Promise<WebhookSubscription> {
  // Validate HTTPS
  if (!targetUrl.startsWith("https://")) {
    throw new Error("Webhook URL must use HTTPS");
  }

  // Generate secure secret
  const secretKey = crypto.randomBytes(32).toString("hex");

  const subscription = await prisma.webhookSubscription.create({
    data: {
      userAddress,
      targetUrl,
      secretKey: encryptWebhookSecret(secretKey),
      eventTypes,
      isActive: true,
    },
  });

  await recordAuditEvent({
    actor: userAddress,
    action: "webhook.create",
    targetType: "webhook",
    targetId: subscription.id,
    outcome: "success",
    after: { targetHost: safeTargetHost(targetUrl), eventTypes, isActive: true },
  });
  return { ...subscription, secretKey } as WebhookSubscription;
}

/**
 * List webhook subscriptions for user
 */
export async function listWebhookSubscriptions(
  userAddress: string,
): Promise<Omit<WebhookSubscription, "secretKey">[]> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: {
      userAddress,
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      userAddress: true,
      targetUrl: true,
      eventTypes: true,
      isActive: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return subscriptions;
}

/**
 * Delete webhook subscription
 */
export async function deleteWebhookSubscription(
  id: string,
  userAddress: string,
): Promise<void> {
  const before = await prisma.webhookSubscription.findFirst({
    where: { id, userAddress },
    select: { targetUrl: true, eventTypes: true, isActive: true },
  });
  const deleted = await prisma.webhookSubscription.updateMany({
    where: {
      id,
      userAddress, // Ensure user owns this webhook
    },
    data: {
      isActive: false,
    },
  });
  if (deleted.count > 0) {
    await recordAuditEvent({
      actor: userAddress,
      action: "webhook.delete",
      targetType: "webhook",
      targetId: id,
      outcome: "success",
      ...(before ? { before: { targetHost: safeTargetHost(before.targetUrl), eventTypes: before.eventTypes, isActive: before.isActive } } : {}),
      after: { isActive: false },
    });
  }
}

export async function updateWebhookSubscription(
  id: string,
  userAddress: string,
  input: { targetUrl?: string; eventTypes?: string[]; isActive?: boolean },
): Promise<Omit<WebhookSubscription, "secretKey">> {
  if (input.targetUrl !== undefined && !input.targetUrl.startsWith("https://")) {
    throw new Error("Webhook URL must use HTTPS");
  }
  const before = await prisma.webhookSubscription.findFirst({
    where: { id, userAddress },
    select: { targetUrl: true, eventTypes: true, isActive: true },
  });
  const subscription = await prisma.webhookSubscription.updateMany({
    where: { id, userAddress },
    data: input,
  });
  if (subscription.count === 0) throw new Error("Webhook subscription not found");
  const updated = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id } });
  await recordAuditEvent({
    actor: userAddress,
    action: "webhook.update",
    targetType: "webhook",
    targetId: id,
    outcome: "success",
    ...(before ? { before: {
      targetHost: safeTargetHost(before.targetUrl),
      eventTypes: before.eventTypes,
      isActive: before.isActive,
    } } : {}),
    after: {
      ...(input.targetUrl !== undefined ? { targetHost: safeTargetHost(input.targetUrl) } : {}),
      ...(input.eventTypes !== undefined ? { eventTypes: input.eventTypes } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    },
  });
  const { secretKey: _secretKey, ...safe } = updated;
  return safe;
}

export async function listWebhookDeliveries(
  id: string,
  userAddress: string,
  page: number,
  limit: number,
) {
  const safePage = Math.max(1, Math.floor(page) || 1);
  const safeLimit = Math.min(100, Math.max(1, Math.floor(limit) || 20));
  const subscription = await prisma.webhookSubscription.findFirst({ where: { id, userAddress } });
  if (!subscription) throw new Error("Webhook subscription not found");
  const [deliveries, total] = await Promise.all([
    prisma.webhookDelivery.findMany({
      where: { subscriptionId: id },
      orderBy: { createdAt: "desc" },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    }),
    prisma.webhookDelivery.count({ where: { subscriptionId: id } }),
  ]);
  return { deliveries, total, page: safePage, limit: safeLimit };
}

export async function regenerateWebhookSecret(id: string, userAddress: string): Promise<string> {
  const owned = await prisma.webhookSubscription.findFirst({
    where: { id, userAddress },
    select: { secretKey: true },
  });
  if (!owned) throw new Error("Webhook subscription not found");
  const secretKey = crypto.randomBytes(32).toString("hex");
  const previousSecretExpiresAt = new Date(Date.now() + SECRET_ROTATION_OVERLAP_MS);
  await prisma.webhookSubscription.update({
    where: { id },
    data: {
      previousSecretKey: owned.secretKey.startsWith(ENCRYPTED_SECRET_PREFIX)
        ? owned.secretKey
        : encryptWebhookSecret(owned.secretKey),
      previousSecretExpiresAt,
      secretKey: encryptWebhookSecret(secretKey),
    },
  });
  await recordAuditEvent({
    actor: userAddress,
    action: "webhook.secret.rotate",
    targetType: "webhook",
    targetId: id,
    outcome: "success",
    before: { hasSecret: true },
    after: { hasSecret: true, previousSecretValidUntil: previousSecretExpiresAt.toISOString() },
  });
  return secretKey;
}

/**
 * Send test webhook ping
 */
export async function sendTestWebhook(
  id: string,
  userAddress: string,
): Promise<{ success: boolean; status?: number; error?: string }> {
  const subscription = await prisma.webhookSubscription.findFirst({
    where: {
      id,
      userAddress,
      isActive: true,
    },
  });

  if (!subscription) {
    throw new Error("Webhook subscription not found");
  }

  const testPayload: WebhookPayload = {
    eventType: "TEST_PING",
    data: {
      message: "This is a test webhook delivery from FlowFi",
    },
    timestamp: new Date().toISOString(),
  };

  return deliverWebhook(subscription as WebhookSubscription, testPayload);
}

/**
 * Deliver webhook with retry logic
 */
export async function deliverWebhook(
  subscription: WebhookSubscription,
  payload: WebhookPayload,
): Promise<{ success: boolean; status?: number; error?: string }> {
  const payloadJson = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const currentSecret = decryptWebhookSecret(subscription.secretKey);
  const signatures = [generateWebhookSignature(payloadJson, currentSecret, timestamp)];
  if (subscription.previousSecretKey &&
      subscription.previousSecretExpiresAt &&
      subscription.previousSecretExpiresAt.getTime() > Date.now()) {
    signatures.push(generateWebhookSignature(
      payloadJson,
      decryptWebhookSecret(subscription.previousSecretKey),
      timestamp,
    ));
  }

  const deliveryId = crypto.randomUUID();

  // Create delivery record
  const delivery = await prisma.webhookDelivery.create({
    data: {
      subscriptionId: subscription.id,
      eventType: payload.eventType,
      payload: payloadJson,
      attempts: 0,
    },
  });

  let lastError: string | undefined;
  let lastStatus: number | undefined;

  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      // Wait for retry delay
      if (attempt > 0) {
        await new Promise((resolve) =>
          setTimeout(resolve, RETRY_DELAYS_MS[attempt]),
        );
      }

      const response = await fetch(subscription.targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-FlowFi-Signature": `t=${timestamp},${signatures.map((signature) => `v1=${signature}`).join(",")}`,
          "X-FlowFi-Event": payload.eventType,
          "X-FlowFi-Delivery-ID": deliveryId,
          "User-Agent": "FlowFi-Webhook/1.0",
        },
        body: payloadJson,
        signal: AbortSignal.timeout(10000), // 10s timeout
      });

      lastStatus = response.status;

      // Update delivery record
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          responseStatus: lastStatus,
          attempts: attempt + 1,
          deliveredAt:
            lastStatus >= 200 && lastStatus < 300 ? new Date() : null,
          error:
            lastStatus >= 200 && lastStatus < 300 ? null : `HTTP ${lastStatus}`,
        },
      });

      if (lastStatus >= 200 && lastStatus < 300) {
        logger.info(
          `[Webhook] Successfully delivered ${payload.eventType} for subscription ${subscription.id} (attempt ${attempt + 1})`,
        );
        return { success: true, status: lastStatus };
      }

      lastError = `HTTP ${lastStatus}`;
      logger.warn(
        `[Webhook] Delivery failed with status ${lastStatus} (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`,
      );
    } catch (error: any) {
      lastError = "Network error";
      logger.warn(
        `[Webhook] Delivery error: ${lastError} (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`,
      );

      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          attempts: attempt + 1,
          error: lastError || null,
        },
      });
    }
  }

  // All retries exhausted - check if we should disable webhook
  await checkConsecutiveFailures(subscription.id);

  return {
    success: false,
    status: lastStatus || 0,
    error: lastError || "Unknown error",
  };
}

/**
 * Check consecutive failures and disable webhook if threshold exceeded
 */
async function checkConsecutiveFailures(subscriptionId: string): Promise<void> {
  const recentDeliveries = await prisma.webhookDelivery.findMany({
    where: {
      subscriptionId,
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 50,
  });

  let consecutiveFailures = 0;
  for (const delivery of recentDeliveries) {
    if (delivery.deliveredAt === null) {
      consecutiveFailures++;
    } else {
      break;
    }
  }

  if (consecutiveFailures >= 50) {
    await prisma.webhookSubscription.update({
      where: { id: subscriptionId },
      data: { isActive: false },
    });

    logger.warn(`[Webhook] Disabled subscription ${subscriptionId} after 50 consecutive failures`);
  }
}

/**
 * Dispatch webhook to all subscribers for an event
 */
export async function dispatchWebhookEvent(
  eventType: string,
  data: Record<string, any>,
  userAddresses: string[],
): Promise<void> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: {
      userAddress: {
        in: userAddresses,
      },
      isActive: true,
      eventTypes: {
        has: eventType,
      },
    },
  });

  const payload: WebhookPayload = {
    eventType,
    data,
    timestamp: new Date().toISOString(),
  };

  // Dispatch to all subscriptions in parallel
  const deliveries = subscriptions.map((subscription) =>
    deliverWebhook(subscription as WebhookSubscription, payload).catch(
      (error) => {
        logger.error(
          `[Webhook] Failed to deliver to ${subscription.targetUrl}:`,
          error,
        );
      },
    ),
  );

  await Promise.all(deliveries);
}
