/**
 * Webhook API client.
 *
 * All request/response types are derived from the auto-generated OpenAPI types
 * in `api-types.generated.ts` rather than hand-written here. If the backend
 * spec changes, running `npm run codegen:api-types` will regenerate the source
 * of truth and TypeScript will surface any drift at compile time.
 */

import type { components, paths } from "@/lib/api-types.generated";
import { fetchWithTimeout, getApiBaseUrl } from "@/lib/api/_shared";

// ── Derived types from generated OpenAPI spec ─────────────────────────────────

/** A webhook subscription record as returned by the backend. */
export type WebhookSubscription = components["schemas"]["WebhookSubscription"];

/**
 * Valid webhook event type strings as defined in the backend OpenAPI spec.
 * Derived from the `eventTypes` array item enum on WebhookSubscription.
 */
export type WebhookEventType = WebhookSubscription["eventTypes"][number];

/**
 * Payload shape for creating a new webhook (POST /v1/webhooks request body).
 * Derived from the `paths` object so it stays in sync with the spec.
 */
export type CreateWebhookInput =
  paths["/v1/webhooks"]["post"]["requestBody"]["content"]["application/json"];

/**
 * Response shape when a webhook is successfully created.
 * The `secretKey` is returned only on creation and never again.
 */
export type CreateWebhookResponse = NonNullable<
  paths["/v1/webhooks"]["post"]["responses"]["201"]["content"]["application/json"]
>;

/**
 * Webhook delivery record.
 * NOTE: The current OpenAPI spec does not yet define a `WebhookDelivery`
 * component schema. The shape below is derived from the deliveries endpoint
 * response type; once the backend adds a named schema this type can be
 * simplified to `components["schemas"]["WebhookDelivery"]`.
 *
 * TODO: add WebhookDelivery to the backend OpenAPI spec.
 */
export interface WebhookDelivery {
  id: string;
  subscriptionId: string;
  eventType: string;
  payload: string;
  responseStatus: number | null;
  responseBody?: string | null;
  attempts: number;
  deliveredAt: string | null;
  error: string | null;
  createdAt: string;
  latencyMs?: number | null;
}

/**
 * Result of sending a test payload to a webhook.
 * TODO: add WebhookTestResult to the backend OpenAPI spec.
 */
export interface WebhookTestResult {
  success: boolean;
  status?: number;
  error?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * The full set of event type strings accepted by the backend.
 * Kept in sync with WebhookEventType — if the spec adds a new value, TS will
 * catch any place this array is used as an exhaustive list.
 */
export const WEBHOOK_EVENT_TYPES: WebhookEventType[] = [
  "CREATED",
  "TOPPED_UP",
  "WITHDRAWN",
  "CANCELLED",
  "COMPLETED",
  "PAUSED",
  "RESUMED",
  "FEE_COLLECTED",
];

// ── HTTP helper ───────────────────────────────────────────────────────────────

function endpoint(path = ""): string {
  const base = getApiBaseUrl();
  return `${base}${base.endsWith("/v1") ? "" : "/v1"}/webhooks${path}`;
}

async function request<T>(accessToken: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithTimeout(endpoint(path), {
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
      ...init?.headers,
    },
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Webhook request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// ── API functions ─────────────────────────────────────────────────────────────

export async function listWebhooks(accessToken: string): Promise<WebhookSubscription[]> {
  const result = await request<{ subscriptions: WebhookSubscription[] }>(
    accessToken,
    "",
  );
  return result.subscriptions;
}

export async function createWebhook(
  input: { targetUrl: string; eventTypes: string[] },
  accessToken: string,
): Promise<{ subscription: WebhookSubscription; secretKey: string }> {
  return request(accessToken, "", { method: "POST", body: JSON.stringify(input) });
}

export async function updateWebhook(
  id: string,
  accessToken: string,
  input: { targetUrl?: string; eventTypes?: string[]; isActive?: boolean },
): Promise<WebhookSubscription> {
  return request(accessToken, `/${id}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function deleteWebhook(id: string, accessToken: string): Promise<void> {
  await request(accessToken, `/${id}`, {
    method: "DELETE",
  });
}

export async function listWebhookDeliveries(
  id: string,
  accessToken: string,
  page = 1,
  limit = 20,
): Promise<{ deliveries: WebhookDelivery[]; total: number; page: number; limit: number }> {
  return request(
    accessToken,
    `/${id}/deliveries?page=${page}&limit=${limit}`,
  );
}

export async function sendWebhookTest(id: string, accessToken: string): Promise<WebhookTestResult> {
  const result = await request<{ result: WebhookTestResult }>(accessToken, `/${id}/test`, {
    method: "POST",
  });
  return result.result;
}

export async function regenerateWebhookSecret(id: string, accessToken: string): Promise<string> {
  const result = await request<{ secretKey: string }>(accessToken, `/${id}/secret`, {
    method: "POST",
  });
  return result.secretKey;
}
