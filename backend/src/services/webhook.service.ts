/**
 * Outgoing Webhook Event Dispatcher with HMAC Signature (Issue #1189)
 * Delivers real-time HTTP POST notifications for stream events
 */
import crypto from "crypto";
import { prisma } from "../lib/prisma.js";
import logger from "../logger.js";

export interface WebhookSubscription {
  id: string;
  userAddress: string;
  targetUrl: string;
  secretKey: string;
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
const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300;

/** Minimal transaction client shape used by the outbox writer. */
export interface OutboxTxClient {
  webhookOutbox: {
    create: (args: any) => Promise<any>;
    upsert?: (args: any) => Promise<any>;
  };
}

export interface EnqueueWebhookEventInput {
  eventType: string;
  data: Record<string, any>;
  /** Unique key so retried business transactions never duplicate outbox rows. */
  dedupeKey: string;
  userAddresses?: string[];
}

export interface OutboxDispatchOptions {
  limit?: number;
  clock?: () => Date;
}

export interface OutboxDispatchResult {
  claimed: number;
  delivered: number;
  failed: number;
  dead: number;
}

/**
 * Produce a stable, sorted-key JSON representation of a payload so that
 * signatures are reproducible regardless of key ordering.
 */
export function canonicalizePayload(payload: unknown): string {
  const seen = new WeakSet<object>();
  const normalize = (value: any): any => {
    if (value === null || typeof value !== "object") return value;
    if (seen.has(value)) throw new Error("Cannot canonicalize circular payload");
    seen.add(value);
    if (Array.isArray(value)) {
      const arr = value.map(normalize);
      seen.delete(value);
      return arr;
    }
    const out: Record<string, any> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = normalize(value[key]);
    }
    seen.delete(value);
    return out;
  };
  return JSON.stringify(normalize(payload));
}

/**
 * Generate HMAC-SHA256 signature for webhook payload.
 * Signature is computed over `${timestamp}.${canonicalBody}`.
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

function safeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify webhook signature (single-secret form).
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  timestamp: number,
  toleranceSeconds = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
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
  return safeEqualHex(signature, expectedSignature);
}

/**
 * Parse an `X-FlowFi-Signature` header of the form `t=...,v1=...,kid=...`.
 */
export function parseSignatureHeader(header: string): {
  timestamp: number;
  signature: string;
  keyId?: string;
} | null {
  if (typeof header !== "string" || header.length === 0) return null;
  const parts: Record<string, string> = {};
  for (const segment of header.split(",")) {
    const idx = segment.indexOf("=");
    if (idx === -1) continue;
    const key = segment.slice(0, idx).trim();
    const value = segment.slice(idx + 1).trim();
    if (key) parts[key] = value;
  }
  const timestamp = Number(parts["t"]);
  const signature = parts["v1"];
  if (!Number.isFinite(timestamp) || !signature) return null;
  return { timestamp, signature, keyId: parts["kid"] };
}

export interface VerifySignedPayloadOptions {
  /** Raw request body as received (will be canonicalized). */
  rawBody: string;
  /** Value of the X-FlowFi-Signature header. */
  signatureHeader: string;
  /** Resolve a secret for a given key id (supports rotation). */
  resolveSecret: (keyId?: string) => string | undefined;
  toleranceSeconds?: number;
  /** Optional nonce to record for replay prevention. */
  nonce?: string;
  now?: number;
}

/**
 * Verify a signed, timestamped payload with key rotation and replay prevention.
 * Returns a structured result; never logs secret or signature material.
 */
export async function verifySignedPayload(
  options: VerifySignedPayloadOptions,
): Promise<{ valid: boolean; reason?: string; keyId?: string }> {
  const parsed = parseSignatureHeader(options.signatureHeader);
  if (!parsed) return { valid: false, reason: "malformed_signature_header" };

  const tolerance =
    options.toleranceSeconds ?? DEFAULT_TIMESTAMP_TOLERANCE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (Math.abs(now - parsed.timestamp) > tolerance) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  const secret = options.resolveSecret(parsed.keyId);
  if (!secret) return { valid: false, reason: "unknown_key_id" };

  let canonicalBody: string;
  try {
    canonicalBody = canonicalizePayload(JSON.parse(options.rawBody));
  } catch {
    return { valid: false, reason: "invalid_body" };
  }

  const expected = generateWebhookSignature(
    canonicalBody,
    secret,
    parsed.timestamp,
  );
  if (!safeEqualHex(parsed.signature, expected)) {
    return { valid: false, reason: "signature_mismatch" };
  }

  if (options.nonce) {
    const expiresAt = new Date((parsed.timestamp + tolerance) * 1000);
    const accepted = await checkAndRecordNonce(options.nonce, expiresAt);
    if (!accepted) return { valid: false, reason: "replayed_nonce" };
  }

  return { valid: true, keyId: parsed.keyId };
}

/**
 * Record a nonce for replay prevention. Returns false if the nonce was
 * already recorded (i.e. a replay).
 */
export async function checkAndRecordNonce(
  nonce: string,
  expiresAt: Date,
): Promise<boolean> {
  try {
    await prisma.webhookReplayNonce.create({
      data: { nonce, expiresAt },
    });
    return true;
  } catch (error: any) {
    // Unique constraint violation => replay.
    if (error?.code === "P2002") return false;
    throw error;
  }
}

/**
 * Write a webhook event to the transactional outbox using the caller's
 * transaction client. `dedupeKey` is unique so retried transactions never
 * create duplicate outbox rows.
 */
export async function enqueueWebhookEvent(
  tx: OutboxTxClient,
  input: EnqueueWebhookEventInput,
): Promise<void> {
  const payload: WebhookPayload = {
    eventType: input.eventType,
    data: input.data,
    timestamp: new Date().toISOString(),
  };
  const body = canonicalizePayload(payload);

  if (typeof tx.webhookOutbox.upsert === "function") {
    await tx.webhookOutbox.upsert({
      where: { dedupeKey: input.dedupeKey },
      create: {
        dedupeKey: input.dedupeKey,
        eventType: input.eventType,
        payload: body,
        userAddresses: input.userAddresses ?? [],
        status: "pending",
        attempts: 0,
        nextAttemptAt: new Date(),
      },
      update: {},
    });
    return;
  }

  await tx.webhookOutbox.create({
    data: {
      dedupeKey: input.dedupeKey,
      eventType: input.eventType,
      payload: body,
      userAddresses: input.userAddresses ?? [],
      status: "pending",
      attempts: 0,
      nextAttemptAt: new Date(),
    },
  });
}

function redactTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "[redacted-url]";
  }
}

async function deliverOutboxRow(
  row: any,
  clock: () => Date,
): Promise<{ success: boolean; status?: number; error?: string }> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: {
      userAddress: { in: row.userAddresses ?? [] },
      isActive: true,
      eventTypes: { has: row.eventType },
    },
  });

  if (subscriptions.length === 0) {
    return { success: true };
  }

  const payloadJson = row.payload as string;
  let lastError: string | undefined;
  let lastStatus: number | undefined;
  let anySuccess = false;

  for (const subscription of subscriptions) {
    const timestamp = Math.floor(clock().getTime() / 1000);
    const signature = generateWebhookSignature(
      payloadJson,
      subscription.secretKey,
      timestamp,
    );
    const deliveryId = crypto.randomUUID();

    try {
      const response = await fetch(subscription.targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-FlowFi-Signature": `t=${timestamp},v1=${signature},kid=default`,
          "X-FlowFi-Event": row.eventType,
          "X-FlowFi-Delivery-ID": deliveryId,
          "User-Agent": "FlowFi-Webhook/1.0",
        },
        body: payloadJson,
        signal: AbortSignal.timeout(10000),
      });
      lastStatus = response.status;
      if (lastStatus >= 200 && lastStatus < 300) {
        anySuccess = true;
      } else {
        lastError = `HTTP ${lastStatus}`;
      }
    } catch (error: any) {
      lastError = error?.message || "Network error";
    }
  }

  if (anySuccess && !lastError) return { success: true, status: lastStatus };
  return { success: false, status: lastStatus, error: lastError };
}

/**
 * Claim and dispatch a batch of pending outbox rows. Retries are bounded by
 * MAX_RETRY_ATTEMPTS and RETRY_DELAYS_MS; attempt state is persisted durably.
 */
export async function dispatchOutboxBatch(
  options: OutboxDispatchOptions = {},
): Promise<OutboxDispatchResult> {
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 20)));
  const clock = options.clock ?? (() => new Date());
  const now = clock();

  const pending = await prisma.webhookOutbox.findMany({
    where: { status: "pending", nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });

  const result: OutboxDispatchResult = {
    claimed: pending.length,
    delivered: 0,
    failed: 0,
    dead: 0,
  };

  for (const row of pending) {
    const attempt = (row.attempts ?? 0) + 1;
    const outcome = await deliverOutboxRow(row, clock);

    if (outcome.success) {
      await prisma.webhookOutbox.update({
        where: { id: row.id },
        data: {
          status: "delivered",
          attempts: attempt,
          deliveredAt: clock(),
          lastError: null,
        },
      });
      result.delivered++;
      continue;
    }

    if (attempt >= MAX_RETRY_ATTEMPTS) {
      await prisma.webhookOutbox.update({
        where: { id: row.id },
        data: {
          status: "dead",
          attempts: attempt,
          lastError: outcome.error ?? "Unknown error",
        },
      });
      result.dead++;
      logger.warn(
        `[Webhook] Outbox row ${row.id} (${row.eventType}) moved to dead after ${attempt} attempts`,
      );
      continue;
    }

    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    await prisma.webhookOutbox.update({
      where: { id: row.id },
      data: {
        status: "pending",
        attempts: attempt,
        lastError: outcome.error ?? "Unknown error",
        nextAttemptAt: new Date(clock().getTime() + delay),
      },
    });
    result.failed++;
  }

  return result;
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
      secretKey,
      eventTypes,
      isActive: true,
    },
  });

  return subscription as WebhookSubscription;
}

/**
 * List webhook subscriptions for user
 */
export async function listWebhookSubscriptions(
  userAddress: string,
): Promise<WebhookSubscription[]> {
  const subscriptions = await prisma.webhookSubscription.findMany({
    where: {
      userAddress,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return subscriptions as WebhookSubscription[];
}

/**
 * Delete webhook subscription
 */
export async function deleteWebhookSubscription(
  id: string,
  userAddress: string,
): Promise<void> {
  await prisma.webhookSubscription.updateMany({
    where: {
      id,
      userAddress, // Ensure user owns this webhook
    },
    data: {
      isActive: false,
    },
  });
}

export async function updateWebhookSubscription(
  id: string,
  userAddress: string,
  input: { targetUrl?: string; eventTypes?: string[]; isActive?: boolean },
): Promise<Omit<WebhookSubscription, "secretKey">> {
  if (input.targetUrl !== undefined && !input.targetUrl.startsWith("https://")) {
    throw new Error("Webhook URL must use HTTPS");
  }
  const subscription = await prisma.webhookSubscription.updateMany({
    where: { id, userAddress },
    data: input,
  });
  if (subscription.count === 0) throw new Error("Webhook subscription not found");
  const updated = await prisma.webhookSubscription.findUniqueOrThrow({ where: { id } });
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
  const owned = await prisma.webhookSubscription.findFirst({ where: { id, userAddress } });
  if (!owned) throw new Error("Webhook subscription not found");
  const secretKey = crypto.randomBytes(32).toString("hex");
  await prisma.webhookSubscription.update({ where: { id }, data: { secretKey } });
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
  const payloadJson = canonicalizePayload(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = generateWebhookSignature(
    payloadJson,
    subscription.secretKey,
    timestamp,
  );

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
          "X-FlowFi-Signature": `t=${timestamp},v1=${signature},kid=default`,
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
          `[Webhook] Successfully delivered ${payload.eventType} to ${redactTarget(subscription.targetUrl)} (attempt ${attempt + 1})`,
        );
        return { success: true, status: lastStatus };
      }

      lastError = `HTTP ${lastStatus}`;
      logger.warn(
        `[Webhook] Delivery failed with status ${lastStatus} (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`,
      );
    } catch (error: any) {
      lastError = error.message || "Network error";
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

    logger.warn(
      `[Webhook] Disabled subscription ${subscriptionId} after 50 consecutive failures`,
    );
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
  const payload: WebhookPayload = {
    eventType,
    data,
    timestamp: new Date().toISOString(),
  };

  // Persist to the outbox first so delivery survives process restarts.
  const dedupeKey = `${eventType}:${crypto
    .createHash("sha256")
    .update(canonicalizePayload(payload))
    .digest("hex")}`;

  await enqueueWebhookEvent(prisma as unknown as OutboxTxClient, {
    eventType,
    data,
    dedupeKey,
    userAddresses,
  });

  // Best-effort immediate dispatch; the scheduler drains remaining rows.
  try {
    await dispatchOutboxBatch({ limit: 20 });
  } catch (error) {
    logger.error(`[Webhook] Outbox dispatch failed for ${eventType}:`, error);
  }
}
