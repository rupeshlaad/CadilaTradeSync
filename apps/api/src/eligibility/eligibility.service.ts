import { ForbiddenException, Injectable } from '@nestjs/common';
import { AccountType, ConnectionStatus, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

export interface EligibilityCheck {
  key: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface EligibilityResult {
  liveEligible: boolean;
  checks: EligibilityCheck[];
  unmetReasons: string[];
}

/**
 * Sprint 1 — Server-authoritative LIVE eligibility gate.
 *
 * This is the SINGLE backend source of truth for "is this user authorized for
 * live copy trading?". It is intentionally ONLY the gate — it contains no
 * broker-specific logic, no risk/UHB logic and no position-sizing logic. Those
 * belong to the future Strategy Risk Engine / Position Sizing Engine / Copy
 * Execution Engine and remain separate responsibilities.
 *
 * Every signal is DERIVED from existing entities (User, TradingAccount,
 * Strategy, Follower, Subscription) — no duplicated state machine.
 */
@Injectable()
export class EligibilityService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluate(userId: string): Promise<EligibilityResult> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        isActive: true,
        emailVerified: true,
        termsAcceptedAt: true,
      },
    });

    if (!user) {
      return {
        liveEligible: false,
        checks: [{ key: 'ACCOUNT', label: 'Account exists', passed: false }],
        unmetReasons: ['Account not found.'],
      };
    }

    const [connectedFollowerAccounts, followerLinks, activeSubscriptions] = await Promise.all([
      this.prisma.tradingAccount.count({
        where: {
          userId,
          accountType: AccountType.FOLLOWER,
          connectionStatus: ConnectionStatus.CONNECTED,
        },
      }),
      this.prisma.follower.count({ where: { followerUserId: userId } }),
      this.prisma.subscription.count({
        where: {
          followerUserId: userId,
          status: { in: [SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE] },
        },
      }),
    ]);

    const profileComplete = !!(user.name && user.name.trim().length > 0);

    const checks: EligibilityCheck[] = [
      {
        key: 'ACCOUNT_ACTIVE',
        label: 'Account is active',
        passed: user.isActive,
        detail: user.isActive ? undefined : 'Your account is disabled.',
      },
      {
        key: 'EMAIL_VERIFIED',
        label: 'Email verified',
        passed: user.emailVerified,
        detail: user.emailVerified ? undefined : 'Verify your email address.',
      },
      {
        key: 'PROFILE_COMPLETE',
        label: 'Profile complete',
        passed: profileComplete,
        detail: profileComplete ? undefined : 'Complete your profile (name).',
      },
      {
        key: 'TERMS_ACCEPTED',
        label: 'Terms accepted',
        passed: !!user.termsAcceptedAt,
        detail: user.termsAcceptedAt ? undefined : 'Accept the terms of service.',
      },
      {
        key: 'BROKER_READY',
        label: 'Broker connected',
        passed: connectedFollowerAccounts > 0,
        detail:
          connectedFollowerAccounts > 0
            ? undefined
            : 'Connect at least one broker account.',
      },
      {
        key: 'STRATEGY_READY',
        label: 'Strategy selected',
        passed: followerLinks > 0,
        detail: followerLinks > 0 ? undefined : 'Subscribe to at least one strategy.',
      },
      {
        key: 'SUBSCRIPTION_READY',
        label: 'Subscription eligible',
        passed: activeSubscriptions > 0,
        detail:
          activeSubscriptions > 0 ? undefined : 'An active or trial subscription is required.',
      },
    ];

    const unmetReasons = checks
      .filter((c) => !c.passed)
      .map((c) => c.detail ?? c.label);

    return {
      liveEligible: unmetReasons.length === 0,
      checks,
      unmetReasons,
    };
  }

  /**
   * Guard helper: throws a clear 403 with the unmet reasons unless the user is
   * fully LIVE eligible. Used to gate activation of live copy trading so a
   * frontend flag can never be the security boundary.
   */
  async assertLiveEligible(userId: string): Promise<void> {
    const result = await this.evaluate(userId);
    if (!result.liveEligible) {
      throw new ForbiddenException({
        message: 'Not eligible for live copy trading yet.',
        reasons: result.unmetReasons,
        error: 'LIVE_ELIGIBILITY_NOT_MET',
      });
    }
  }
}
