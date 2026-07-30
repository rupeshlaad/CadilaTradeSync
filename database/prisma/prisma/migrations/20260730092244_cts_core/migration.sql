-- CreateEnum
CREATE TYPE "Broker" AS ENUM ('ZERODHA', 'FYERS', 'ANGEL_ONE', 'UPSTOX', 'DHAN', 'ICICI_DIRECT', 'SHOONYA');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('DISCONNECTED', 'CONNECTING', 'CONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PRIVATE', 'PUBLIC');

-- CreateEnum
CREATE TYPE "StrategyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'CANCELLED');

-- CreateTable
CREATE TABLE "trading_accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "broker" "Broker" NOT NULL,
    "platform" TEXT NOT NULL,
    "nickname" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "encryptedApiKey" TEXT,
    "encryptedApiSecret" TEXT,
    "encryptedPassword" TEXT,
    "encryptedTotpSecret" TEXT,
    "staticIpPrimary" TEXT,
    "staticIpSecondary" TEXT,
    "connectionStatus" "ConnectionStatus" NOT NULL DEFAULT 'DISCONNECTED',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "healthScore" INTEGER NOT NULL DEFAULT 0,
    "lastHeartbeat" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "trading_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategies" (
    "id" TEXT NOT NULL,
    "tradingAccountId" TEXT NOT NULL,
    "strategyName" TEXT NOT NULL,
    "description" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "visibility" "Visibility" NOT NULL DEFAULT 'PRIVATE',
    "masterAccount" BOOLEAN NOT NULL DEFAULT false,
    "baseQuantity" INTEGER NOT NULL DEFAULT 1,
    "maxFollowers" INTEGER NOT NULL DEFAULT 0,
    "status" "StrategyStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strategies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "followers" (
    "id" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "followerUserId" TEXT NOT NULL,
    "tradingAccountId" TEXT NOT NULL,
    "multiplier" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "maximumLoss" DOUBLE PRECISION,
    "maximumDailyLoss" DOUBLE PRECISION,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "followers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "followerUserId" TEXT NOT NULL,
    "strategyId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIAL',
    "startDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "trading_accounts_userId_idx" ON "trading_accounts"("userId");

-- CreateIndex
CREATE INDEX "strategies_tradingAccountId_idx" ON "strategies"("tradingAccountId");

-- CreateIndex
CREATE INDEX "followers_strategyId_idx" ON "followers"("strategyId");

-- CreateIndex
CREATE INDEX "followers_followerUserId_idx" ON "followers"("followerUserId");

-- CreateIndex
CREATE INDEX "followers_tradingAccountId_idx" ON "followers"("tradingAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "followers_strategyId_followerUserId_key" ON "followers"("strategyId", "followerUserId");

-- CreateIndex
CREATE INDEX "subscriptions_followerUserId_idx" ON "subscriptions"("followerUserId");

-- CreateIndex
CREATE INDEX "subscriptions_strategyId_idx" ON "subscriptions"("strategyId");

-- AddForeignKey
ALTER TABLE "trading_accounts" ADD CONSTRAINT "trading_accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "followers" ADD CONSTRAINT "followers_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "followers" ADD CONSTRAINT "followers_followerUserId_fkey" FOREIGN KEY ("followerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "followers" ADD CONSTRAINT "followers_tradingAccountId_fkey" FOREIGN KEY ("tradingAccountId") REFERENCES "trading_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_followerUserId_fkey" FOREIGN KEY ("followerUserId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "strategies"("id") ON DELETE CASCADE ON UPDATE CASCADE;
