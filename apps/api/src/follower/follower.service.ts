import { Injectable } from '@nestjs/common';
import { AccountType, ConnectionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';

/**
 * Sprint 6.1 — Follower-scoped read services.
 *
 * Pure presentation aggregates over existing tables (User,
 * TradingAccount, Follower, Subscription, BrokerSession). No new
 * schema, no calculations beyond `COUNT` / `MAX` / existence checks.
 * Both endpoints reuse the same aggregation to avoid divergence
 * between the onboarding widget and the dashboard header.
 */
@Injectable()
export class FollowerService {
  constructor(private readonly prisma: PrismaService) {}

  private async aggregate(userId: string) {
    const [user, brokerAccounts, followers, subscriptions] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
          emailVerified: true,
          termsAcceptedAt: true,
        },
      }),
      this.prisma.tradingAccount.findMany({
        where: { userId, accountType: AccountType.FOLLOWER },
        select: {
          id: true,
          connectionStatus: true,
          enabled: true,
          lastHeartbeat: true,
        },
      }),
      this.prisma.follower.count({
        where: { followerUserId: userId, enabled: true },
      }),
      this.prisma.subscription.count({
        where: { followerUserId: userId, status: 'ACTIVE' },
      }),
    ]);

    const connectedBrokers = brokerAccounts.filter(
      (a) => a.connectionStatus === ConnectionStatus.CONNECTED,
    );
    const lastSync = brokerAccounts.reduce<Date | null>((acc, cur) => {
      if (!cur.lastHeartbeat) return acc;
      if (!acc || cur.lastHeartbeat > acc) return cur.lastHeartbeat;
      return acc;
    }, null);

    return {
      user,
      totalBrokers: brokerAccounts.length,
      connectedBrokers: connectedBrokers.length,
      activeFollowers: followers,
      activeSubscriptions: subscriptions,
      lastSync,
    };
  }

  /**
   * Computes the follower's onboarding progress. Each step is
   * observable from the existing schema — no new tracking table.
   */
  async getOnboardingStatus(userId: string) {
    const a = await this.aggregate(userId);

    // Profile complete = user has a non-empty display name.
    // (Follower registration collects name; blank means never filled.)
    const profileComplete = !!(a.user?.name && a.user.name.trim().length > 0);

    const brokerConnected = a.connectedBrokers > 0;
    // Risk configured = follower has AT LEAST one enabled follower row
    // with a non-null maximumLoss or maximumDailyLoss cap.
    const riskConfigured = await this.prisma.follower.count({
      where: {
        followerUserId: userId,
        enabled: true,
        OR: [{ maximumLoss: { not: null } }, { maximumDailyLoss: { not: null } }],
      },
    });
    const strategySubscribed = a.activeFollowers > 0 || a.activeSubscriptions > 0;
    const emailVerified = !!a.user?.emailVerified;
    const termsAccepted = !!a.user?.termsAcceptedAt;
    const readyForTrading =
      profileComplete && brokerConnected && strategySubscribed;

    const steps = [
      {
        key: 'PROFILE',
        label: 'Profile Completed',
        complete: profileComplete,
      },
      {
        key: 'EMAIL_VERIFIED',
        label: 'Email Verified',
        complete: emailVerified,
      },
      {
        key: 'TERMS',
        label: 'Terms Accepted',
        complete: termsAccepted,
      },
      {
        key: 'BROKER',
        label: 'Broker Connected',
        complete: brokerConnected,
      },
      {
        key: 'RISK',
        label: 'Risk Configured',
        complete: riskConfigured > 0,
      },
      {
        key: 'STRATEGY',
        label: 'Strategy Subscribed',
        complete: strategySubscribed,
      },
      {
        key: 'READY',
        label: 'Ready for Trading',
        complete: readyForTrading,
      },
    ];

    const completedCount = steps.filter((s) => s.complete).length;
    return {
      steps,
      completedCount,
      totalCount: steps.length,
      readyForTrading,
    };
  }

  /**
   * Header payload for the Follower dashboard.
   */
  async getDashboardSummary(userId: string) {
    const a = await this.aggregate(userId);
    return {
      userName: a.user?.name ?? null,
      userEmail: a.user?.email ?? null,
      totalBrokers: a.totalBrokers,
      connectedBrokers: a.connectedBrokers,
      activeStrategies: a.activeFollowers,
      activeSubscriptions: a.activeSubscriptions,
      lastSync: a.lastSync ? a.lastSync.toISOString() : null,
    };
  }
}
