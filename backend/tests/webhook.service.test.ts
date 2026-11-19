import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteWebhookSubscription,
  purgeExpiredAlertHistory,
  purgeExpiredWebhookDeliveries,
  validateWebhookFilters,
  validateWebhookSchemaVersion,
  normalizeWebhookSubscription,
  serializeWebhookPayload,
  shouldDeliverEvent,
  recordDeliverySuccess,
  recordDeliveryFailure,
  getWebhookHealth,
  SUPPORTED_WEBHOOK_EVENTS,
  SUPPORTED_WEBHOOK_SCHEMA_VERSIONS,
} from "../src/services/webhook.service.js";
import { prisma } from "../src/lib/prisma.js";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    webhookSubscription: {
      deleteMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    webhookDelivery: {
      deleteMany: vi.fn(),
    },
    alertHistory: {
      deleteMany: vi.fn(),
    },
  },
}));

describe("webhook subscription deletion", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hard-deletes only the subscription owned by the requesting wallet", async () => {
    await deleteWebhookSubscription("subscription-id", "GOWNER");

    expect(prisma.webhookSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: "subscription-id", userAddress: "GOWNER" },
    });
  });

  it("purges delivery records older than 30 days", async () => {
    vi.mocked(prisma.webhookDelivery.deleteMany).mockResolvedValue({ count: 2 });

    const deletedCount = await purgeExpiredWebhookDeliveries(
      new Date("2026-10-18T12:00:00.000Z"),
    );

    expect(deletedCount).toBe(2);
    expect(prisma.webhookDelivery.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: new Date("2026-09-18T12:00:00.000Z") } },
    });
  });

  it("purges alert records older than 90 days", async () => {
    vi.mocked(prisma.alertHistory.deleteMany).mockResolvedValue({ count: 1 });

    const deletedCount = await purgeExpiredAlertHistory(
      new Date("2026-10-18T12:00:00.000Z"),
    );

    expect(deletedCount).toBe(1);
    expect(prisma.alertHistory.deleteMany).toHaveBeenCalledWith({
      where: { sentAt: { lt: new Date("2026-07-20T12:00:00.000Z") } },
    });
  });
});

describe("webhook subscription filter validation", () => {
  it("accepts supported event families", () => {
    expect(() =>
      validateWebhookFilters([SUPPORTED_WEBHOOK_EVENTS[0]]),
    ).not.toThrow();
  });

  it("rejects unknown event families at configuration time", () => {
    expect(() => validateWebhookFilters(["not.a.real.event"])).toThrow(
      /unknown webhook event/i,
    );
  });

  it("rejects non-array filters", () => {
    expect(() => validateWebhookFilters("trade.created" as unknown)).toThrow(
      /array/i,
    );
  });

  it("accepts supported schema versions", () => {
    for (const version of SUPPORTED_WEBHOOK_SCHEMA_VERSIONS) {
      expect(() => validateWebhookSchemaVersion(version)).not.toThrow();
    }
  });

  it("rejects unsupported schema versions", () => {
    expect(() => validateWebhookSchemaVersion("v99")).toThrow(
      /unsupported webhook schema version/i,
    );
  });

  it("rejects non-string schema versions", () => {
    expect(() => validateWebhookSchemaVersion(1 as unknown)).toThrow(
      /unsupported webhook schema version/i,
    );
  });
});

describe("webhook subscription normalization", () => {
  it("defaults legacy subscriptions to all events and v1", () => {
    const normalized = normalizeWebhookSubscription({
      id: "sub-1",
      userAddress: "GOWNER",
      url: "https://example.com/hook",
    });

    expect(normalized.events).toEqual(SUPPORTED_WEBHOOK_EVENTS);
    expect(normalized.schemaVersion).toBe("v1");
  });

  it("preserves explicit filters and schema version", () => {
    const normalized = normalizeWebhookSubscription({
      id: "sub-2",
      userAddress: "GOWNER",
      url: "https://example.com/hook",
      events: [SUPPORTED_WEBHOOK_EVENTS[0]],
      schemaVersion: "v1",
    });

    expect(normalized.events).toEqual([SUPPORTED_WEBHOOK_EVENTS[0]]);
    expect(normalized.schemaVersion).toBe("v1");
  });
});

describe("webhook event filtering", () => {
  it("delivers events that match the subscription filter", () => {
    expect(
      shouldDeliverEvent(
        { events: [SUPPORTED_WEBHOOK_EVENTS[0]] },
        SUPPORTED_WEBHOOK_EVENTS[0],
      ),
    ).toBe(true);
  });

  it("skips unknown events", () => {
    expect(
      shouldDeliverEvent(
        { events: SUPPORTED_WEBHOOK_EVENTS },
        "not.a.real.event",
      ),
    ).toBe(false);
  });

  it("skips events excluded by the filter", () => {
    expect(
      shouldDeliverEvent(
        { events: [SUPPORTED_WEBHOOK_EVENTS[0]] },
        SUPPORTED_WEBHOOK_EVENTS[1],
      ),
    ).toBe(false);
  });
});

describe("webhook payload serialization", () => {
  it("serializes v1 payloads with the documented envelope", () => {
    const payload = serializeWebhookPayload("v1", {
      event: SUPPORTED_WEBHOOK_EVENTS[0],
      data: { id: "trade-1" },
    });

    expect(payload).toMatchObject({
      schemaVersion: "v1",
      event: SUPPORTED_WEBHOOK_EVENTS[0],
      data: { id: "trade-1" },
    });
  });

  it("rejects serialization for unsupported schema versions", () => {
    expect(() =>
      serializeWebhookPayload("v99", {
        event: SUPPORTED_WEBHOOK_EVENTS[0],
        data: {},
      }),
    ).toThrow(/unsupported webhook schema version/i);
  });
});

describe("webhook delivery health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a sanitized failure category on failure", async () => {
    vi.mocked(prisma.webhookSubscription.update).mockResolvedValue({} as never);

    await recordDeliveryFailure("sub-1", "http_500");

    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
      where: { id: "sub-1" },
      data: expect.objectContaining({
        lastFailureCategory: "http_500",
        lastFailureAt: expect.any(Date),
      }),
    });
  });

  it("clears failure category and sets lastSuccessAt on recovery", async () => {
    vi.mocked(prisma.webhookSubscription.update).mockResolvedValue({} as never);

    await recordDeliverySuccess("sub-1");

    expect(prisma.webhookSubscription.update).toHaveBeenCalledWith({
      where: { id: "sub-1" },
      data: expect.objectContaining({
        lastFailureCategory: null,
        lastSuccessAt: expect.any(Date),
      }),
    });
  });

  it("returns health for the owning wallet without leaking secrets", async () => {
    vi.mocked(prisma.webhookSubscription.findFirst).mockResolvedValue({
      id: "sub-1",
      userAddress: "GOWNER",
      url: "https://example.com/hook",
      secretKey: "super-secret",
      lastSuccessAt: new Date("2026-10-18T12:00:00.000Z"),
      lastFailureCategory: null,
    } as never);

    const health = await getWebhookHealth("sub-1", "GOWNER");

    expect(health).toMatchObject({
      id: "sub-1",
      lastSuccessAt: new Date("2026-10-18T12:00:00.000Z"),
      lastFailureCategory: null,
    });
    expect(JSON.stringify(health)).not.toContain("super-secret");
    expect(health).not.toHaveProperty("secretKey");
    expect(health).not.toHaveProperty("responseBody");
  });

  it("rejects health access for non-owners", async () => {
    vi.mocked(prisma.webhookSubscription.findFirst).mockResolvedValue(null);

    await expect(getWebhookHealth("sub-1", "GOTHER")).rejects.toThrow(
      /not found/i,
    );
  });
});
