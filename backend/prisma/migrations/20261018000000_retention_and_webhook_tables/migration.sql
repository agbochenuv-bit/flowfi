-- Persist webhook configuration and delivery history with owner deletion cascading to deliveries.
CREATE TABLE IF NOT EXISTS "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "userAddress" TEXT NOT NULL,
    "targetUrl" TEXT NOT NULL,
    "secretKey" TEXT NOT NULL,
    "eventTypes" TEXT[] NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "deliveredAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "WebhookDelivery"
    DROP CONSTRAINT IF EXISTS "WebhookDelivery_subscriptionId_fkey";
ALTER TABLE "WebhookDelivery"
    ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "WebhookSubscription_userAddress_idx"
    ON "WebhookSubscription"("userAddress");
CREATE INDEX IF NOT EXISTS "WebhookSubscription_isActive_idx"
    ON "WebhookSubscription"("isActive");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_subscriptionId_idx"
    ON "WebhookDelivery"("subscriptionId");
CREATE INDEX IF NOT EXISTS "WebhookDelivery_createdAt_idx"
    ON "WebhookDelivery"("createdAt");

-- Raw protocol-level metrics contain no wallet identifiers. Retain bounded
-- snapshots while preserving the long-lived aggregate views.
SELECT add_retention_policy(
    'stream_flow_snapshots',
    INTERVAL '90 days',
    if_not_exists => TRUE
);
