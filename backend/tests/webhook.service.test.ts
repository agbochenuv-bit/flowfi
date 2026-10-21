import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteWebhookSubscription,
  purgeExpiredAlertHistory,
  purgeExpiredWebhookDeliveries,
} from "../src/services/webhook.service.js";
import { prisma } from "../src/lib/prisma.js";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    webhookSubscription: {
      deleteMany: vi.fn(),
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
