-- CreateEnum
CREATE TYPE "BackfillStatus" AS ENUM ('PENDING', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "BackfillJob" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "fromLedger" INTEGER NOT NULL,
    "toLedger" INTEGER NOT NULL,
    "status" "BackfillStatus" NOT NULL DEFAULT 'PENDING',
    "currentLedger" INTEGER NOT NULL DEFAULT 0,
    "eventsProcessed" INTEGER NOT NULL DEFAULT 0,
    "eventsFailed" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackfillJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BackfillJob_status_idx" ON "BackfillJob"("status");

-- CreateIndex
CREATE INDEX "BackfillJob_fromLedger_toLedger_idx" ON "BackfillJob"("fromLedger", "toLedger");

-- CreateIndex
CREATE INDEX "BackfillJob_createdAt_idx" ON "BackfillJob"("createdAt");
