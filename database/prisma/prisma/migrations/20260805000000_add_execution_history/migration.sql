-- Sprint 5.2 — permanent execution audit trail
--
-- New tables:
--   execution_history           — one row per CopyTradingService.handleTrade()
--   execution_follower_results  — one row per follower attempt inside a handleTrade()
--
-- Migration is intentionally forward-only and additive. No existing
-- tables, columns or enums are modified.

-- CreateTable
CREATE TABLE "execution_history" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "strategyId" TEXT,
    "strategyName" TEXT,
    "masterAccountId" TEXT NOT NULL,
    "masterAccountName" TEXT,
    "masterBroker" TEXT NOT NULL,
    "masterSymbol" TEXT NOT NULL,
    "masterExchange" TEXT,
    "masterSegment" TEXT,
    "masterSide" TEXT NOT NULL,
    "masterQuantity" INTEGER NOT NULL,
    "masterPrice" DOUBLE PRECISION,
    "orderType" TEXT,
    "productType" TEXT,
    "tradeSource" TEXT,
    "status" TEXT NOT NULL,
    "totalFollowers" INTEGER NOT NULL DEFAULT 0,
    "successfulFollowers" INTEGER NOT NULL DEFAULT 0,
    "failedFollowers" INTEGER NOT NULL DEFAULT 0,
    "skippedFollowers" INTEGER NOT NULL DEFAULT 0,
    "processingTimeMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_follower_results" (
    "id" TEXT NOT NULL,
    "executionHistoryId" TEXT NOT NULL,
    "followerId" TEXT,
    "followerEmail" TEXT,
    "broker" TEXT NOT NULL,
    "brokerOrderId" TEXT,
    "status" TEXT NOT NULL,
    "failureType" TEXT,
    "failureReason" TEXT,
    "rawBrokerResponse" JSONB,
    "followerSymbol" TEXT,
    "executedQuantity" INTEGER,
    "executedPrice" DOUBLE PRECISION,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "execution_follower_results_pkey" PRIMARY KEY ("id")
);

-- Indexes for search filters used by /admin/execution-history query
CREATE INDEX "execution_history_timestamp_idx"       ON "execution_history"("timestamp");
CREATE INDEX "execution_history_createdAt_idx"       ON "execution_history"("createdAt");
CREATE INDEX "execution_history_strategyId_idx"      ON "execution_history"("strategyId");
CREATE INDEX "execution_history_masterAccountId_idx" ON "execution_history"("masterAccountId");
CREATE INDEX "execution_history_masterBroker_idx"    ON "execution_history"("masterBroker");
CREATE INDEX "execution_history_masterSymbol_idx"    ON "execution_history"("masterSymbol");
CREATE INDEX "execution_history_status_idx"          ON "execution_history"("status");

CREATE INDEX "execution_follower_results_executionHistoryId_idx" ON "execution_follower_results"("executionHistoryId");
CREATE INDEX "execution_follower_results_status_idx"             ON "execution_follower_results"("status");
CREATE INDEX "execution_follower_results_broker_idx"             ON "execution_follower_results"("broker");
CREATE INDEX "execution_follower_results_failureType_idx"        ON "execution_follower_results"("failureType");

-- AddForeignKey
ALTER TABLE "execution_follower_results"
    ADD CONSTRAINT "execution_follower_results_executionHistoryId_fkey"
    FOREIGN KEY ("executionHistoryId") REFERENCES "execution_history"("id") ON DELETE CASCADE ON UPDATE CASCADE;
