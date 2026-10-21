/**
 * Outgoing Webhook Event Dispatcher with HMAC Signature (Issue #1189)
 * Delivers real-time HTTP POST notifications for stream events
 */
import crypto from "crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
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
const WEBHOOK_DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ALERT_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export async function purgeExpiredWebhookDeliveries(
  now = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_MS);
  const result = await prisma.webhookDelivery.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });
  return result.count;
}

export async function purgeExpiredAlertHistory(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - ALERT_HISTORY_RETENTION_MS);
  const result = await prisma.alertHistory.deleteMany({
    where: { sentAt: { lt: cutoff } },
  });
  return result.count;
}

type ResolvedAddress = { address: string; family: number };
type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>;

const IPV4_DENY_RANGES: Array<[number, number]> = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8],
  [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0586300, 24], [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
  [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];

function inIpv4Range(address: number, network: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (network & mask);
}

function ipv4Number(address: string): number {
  return address.split('.').reduce((value, octet) => (value * 256) + Number(octet), 0) >>> 0;
}

function ipv6Number(address: string): bigint | null {
  let value = address.toLowerCase().split('%')[0] ?? '';
  if (value.includes('.')) {
    const separator = value.lastIndexOf(':');
    const ipv4 = value.slice(separator + 1);
    if (isIP(ipv4) !== 4) return null;
    const number = ipv4Number(ipv4);
    value = `${value.slice(0, separator)}:${(number >>> 16).toString(16)}:${(number & 0xffff).toString(16)}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const words = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.reduce((result, word) => (result << 16n) | BigInt(`0x${word}`), 0n);
}

export function isPublicWebhookAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const number = ipv4Number(address);
    return !IPV4_DENY_RANGES.some(([network, prefix]) => inIpv4Range(number, network, prefix));
  }
  if (family !== 6) return false;

  const number = ipv6Number(address);
  if (number === null) return false;
  const firstWord = Number((number >> 112n) & 0xffffn);
  const secondWord = Number((number >> 96n) & 0xffffn);
  const inGlobalUnicast = (number >> 125n) === 1n;
  const specialUse =
    (firstWord === 0x2001 && secondWord <= 0x01ff) ||
    (firstWord === 0x2001 && secondWord >= 0x0200 && secondWord <= 0x03ff) ||
    (firstWord === 0x2001 && secondWord === 0x0db8) ||
    (firstWord === 0x2002) ||
    (firstWord === 0x3fff && secondWord <= 0x0fff);
  return inGlobalUnicast && !specialUse;
}

const resolveAddresses: AddressResolver = async (hostname) => {
  const unwrappedHostname = hostname.replace(/^\[|\]$/g, '');
  const family = isIP(unwrappedHostname);
  if (family) return [{ address: unwrappedHostname, family }];
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      dnsLookup(unwrappedHostname, { all: true, verbatim: true }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Webhook DNS lookup timed out')), 5_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

export async function resolveSafeWebhookTarget(
  target: string,
  resolver: AddressResolver = resolveAddresses,
): Promise<{ url: URL; addresses: ResolvedAddress[] }> {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new Error('Webhook URL must be a valid HTTPS URL');
  }
  if (url.protocol !== 'https:') throw new Error('Webhook URL must use HTTPS');
  if (url.username || url.password) throw new Error('Webhook URL must not contain credentials');
  if (url.hash) throw new Error('Webhook URL must not contain a fragment');

  const addresses = await resolver(url.hostname);
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicWebhookAddress(address))) {
    throw new Error('Webhook URL must resolve only to public IP addresses');
  }
  return { url, addresses };
}

function webhookOrigin(target: string): string {
  try {
    return new URL(target).origin;
  } catch {
    return 'invalid destination';
  }
}

export function createPinnedWebhookLookup(addresses: ResolvedAddress[]): LookupFunction {
  if (addresses.length === 0) throw new Error('At least one validated webhook address is required');
  return (_hostname, options, callback) => {
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0]!.address, addresses[0]!.family);
  };
}

export function postToPinnedTarget(
  url: URL,
  addresses: ResolvedAddress[],
  headers: Record<string, string>,
  body: string,
): Promise<number> {
  const pinnedLookup = createPinnedWebhookLookup(addresses);

  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'POST',
      headers,
      lookup: pinnedLookup,
    }, (response) => {
      clearTimeout(timeout);
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    const timeout = setTimeout(() => request.destroy(new Error('Webhook request timed out')), 10_000);
    request.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.end(body);
  });
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
  const { url } = await resolveSafeWebhookTarget(targetUrl);

  // Generate secure secret
  const secretKey = crypto.randomBytes(32).toString("hex");

  const subscription = await prisma.webhookSubscription.create({
    data: {
      userAddress,
      targetUrl: url.href,
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
  await prisma.webhookSubscription.deleteMany({
    where: {
      id,
      userAddress, // Ensure user owns this webhook
    },
  });
}

export async function updateWebhookSubscription(
  id: string,
  userAddress: string,
  input: { targetUrl?: string; eventTypes?: string[]; isActive?: boolean },
): Promise<Omit<WebhookSubscription, "secretKey">> {
  const data = input.targetUrl === undefined
    ? input
    : { ...input, targetUrl: (await resolveSafeWebhookTarget(input.targetUrl)).url.href };
  const subscription = await prisma.webhookSubscription.updateMany({
    where: { id, userAddress },
    data,
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
  const payloadJson = JSON.stringify(payload);
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

      const { url, addresses } = await resolveSafeWebhookTarget(subscription.targetUrl);
      lastStatus = await postToPinnedTarget(url, addresses, {
          "Content-Type": "application/json",
          "X-FlowFi-Signature": `t=${timestamp},v1=${signature}`,
          "X-FlowFi-Event": payload.eventType,
          "X-FlowFi-Delivery-ID": deliveryId,
          "User-Agent": "FlowFi-Webhook/1.0",
        }, payloadJson);

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
          `[Webhook] Delivered ${payload.eventType} with status ${lastStatus} (attempt ${attempt + 1})`,
        );
        return { success: true, status: lastStatus };
      }

      lastError = `HTTP ${lastStatus}`;
      logger.warn(
        `[Webhook] Delivery failed with status ${lastStatus} (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`,
      );
    } catch {
      lastError = "Network error";
      logger.warn(
        `[Webhook] Delivery failed with a network error (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS})`,
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
        logger.error(`[Webhook] Dispatch failed for ${payload.eventType}`);
      },
    ),
  );

  await Promise.all(deliveries);
}

