CREATE TABLE "PrivacyReceipt" (
    "id" TEXT NOT NULL,
    "walletAddress" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "subscriptions" INTEGER NOT NULL,
    "deliveries" INTEGER NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PrivacyReceipt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PrivacyReceipt_walletAddress_completedAt_idx"
    ON "PrivacyReceipt"("walletAddress", "completedAt");
