import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { BrokerService } from '../brokers/broker.service';
import { SubscribeDto } from './dto/subscribe.dto';
import { UpdateFollowerDto } from './dto/update-follower.dto';
import { AccountType, SubscriptionStatus, Visibility } from '@prisma/client';
import { BROKER_LABELS } from '@cts/shared';

@Injectable()
export class FollowersService {
  constructor(
    private readonly prisma: PrismaService,
    // Sprint 6.1.4 — reuse the SAME broker session engine the Master Portal
    // uses so admins can inspect follower broker health without a parallel
    // implementation and without logging into the follower portal.
    private readonly broker: BrokerService,
  ) {}

  private serialize(row: any) {
    return {
      ...row,
      createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
    };
  }

  async listMyFollowers(userId: string) {
    const rows = await this.prisma.follower.findMany({
      where: { strategy: { tradingAccount: { userId } } },
      orderBy: { createdAt: 'desc' },
      include: {
        strategy: { select: { strategyName: true, visibility: true, status: true } },
        tradingAccount: { select: { nickname: true, broker: true } },
        followerUser: { select: { email: true, name: true } },
      },
    });
    return rows.map((r) => this.serialize(r));
  }

  async listWhereIFollow(userId: string) {
    const rows = await this.prisma.follower.findMany({
      where: { followerUserId: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        strategy: { select: { strategyName: true, visibility: true, status: true } },
        tradingAccount: { select: { nickname: true, broker: true } },
      },
    });
    return rows.map((r) => this.serialize(r));
  }

  async subscribe(userId: string, dto: SubscribeDto) {
    const strategy = await this.prisma.strategy.findUnique({
      where: { id: dto.strategyId },
      include: { tradingAccount: true, _count: { select: { followers: true } } },
    });
    if (!strategy) throw new NotFoundException('Strategy not found');

    if (strategy.tradingAccount.userId === userId) {
      throw new BadRequestException('You cannot follow your own strategy');
    }
    if (strategy.visibility !== Visibility.PUBLIC) {
      throw new ForbiddenException('Strategy is not public');
    }
    if (!strategy.enabled) {
      throw new BadRequestException('Strategy is disabled');
    }
    if (strategy.maxFollowers > 0 && strategy._count.followers >= strategy.maxFollowers) {
      throw new BadRequestException('Strategy follower limit reached');
    }

    const acc = await this.prisma.tradingAccount.findUnique({ where: { id: dto.tradingAccountId } });
    if (!acc) throw new NotFoundException('Follower trading account not found');
    if (acc.userId !== userId) throw new ForbiddenException('You do not own this trading account');

    const existing = await this.prisma.follower.findUnique({
      where: { strategyId_followerUserId: { strategyId: dto.strategyId, followerUserId: userId } },
    });
    if (existing) throw new BadRequestException('Already subscribed to this strategy');

    const [follower] = await this.prisma.$transaction([
      this.prisma.follower.create({
        data: {
          strategyId: dto.strategyId,
          followerUserId: userId,
          tradingAccountId: dto.tradingAccountId,
          multiplier: dto.multiplier,
          maximumLoss: dto.maximumLoss ?? null,
          maximumDailyLoss: dto.maximumDailyLoss ?? null,
        },
      }),
      this.prisma.subscription.create({
        data: {
          followerUserId: userId,
          strategyId: dto.strategyId,
          status: SubscriptionStatus.TRIAL,
        },
      }),
    ]);
    return this.serialize(follower);
  }

  async update(userId: string, id: string, dto: UpdateFollowerDto) {
    const row = await this.prisma.follower.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    if (row.followerUserId !== userId) throw new ForbiddenException();
    const updated = await this.prisma.follower.update({
      where: { id },
      data: {
        multiplier: dto.multiplier ?? undefined,
        maximumLoss: dto.maximumLoss ?? undefined,
        maximumDailyLoss: dto.maximumDailyLoss ?? undefined,
        enabled: dto.enabled ?? undefined,
      },
    });
    return this.serialize(updated);
  }

  async unsubscribe(userId: string, id: string) {
    const row = await this.prisma.follower.findUnique({ where: { id } });
    if (!row) throw new NotFoundException();
    if (row.followerUserId !== userId) throw new ForbiddenException();
    await this.prisma.$transaction([
      this.prisma.follower.delete({ where: { id } }),
      this.prisma.subscription.updateMany({
        where: { followerUserId: userId, strategyId: row.strategyId, status: { in: [SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE] } },
        data: { status: SubscriptionStatus.CANCELLED, endDate: new Date() },
      }),
    ]);
    return { ok: true };
  }

  async listAllForAdmin() {
    const rows = await this.prisma.follower.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        strategy: { select: { strategyName: true, visibility: true, status: true } },
        tradingAccount: { select: { nickname: true, broker: true } },
        followerUser: { select: { email: true, name: true } },
      },
    });
    return rows.map((r) => this.serialize(r));
  }

  /**
   * Sprint 6.1.4 — Admin: toggle a follower link (this IS the copy-trading
   * gate — CopyTradingService only fans out to Follower rows where
   * enabled = true). "Pause Copy Trading" == disable; "Resume" == enable.
   */
  async setEnabledByAdmin(followerId: string, enabled: boolean) {
    const row = await this.prisma.follower.findUnique({ where: { id: followerId } });
    if (!row) throw new NotFoundException('Follower not found');
    const updated = await this.prisma.follower.update({
      where: { id: followerId },
      data: { enabled },
    });
    return this.serialize(updated);
  }

  /**
   * Sprint 6.1.4 — Admin operational overview for one follower USER.
   * Aggregates existing tables + reuses BrokerService for broker health.
   * Never returns credentials/secrets.
   */
  async getFollowerOverview(followerUserId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: followerUserId },
    });
    if (!user) throw new NotFoundException('Follower not found');

    const [accounts, follows, subs] = await Promise.all([
      this.prisma.tradingAccount.findMany({
        where: { userId: followerUserId, accountType: AccountType.FOLLOWER },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.follower.findMany({
        where: { followerUserId },
        orderBy: { createdAt: 'desc' },
        include: {
          strategy: { select: { strategyName: true, status: true } },
        },
      }),
      this.prisma.subscription.findMany({
        where: { followerUserId },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    // Broker accounts — reuse the shared session-health engine.
    const brokerAccounts = await Promise.all(
      accounts.map(async (acc) => {
        const h = await this.broker.getSessionHealth(acc.id);
        return {
          id: acc.id,
          broker: acc.broker,
          brokerLabel:
            BROKER_LABELS[acc.broker as keyof typeof BROKER_LABELS] ?? acc.broker,
          nickname: acc.nickname,
          clientId: acc.clientId,
          accountHolder: h.accountHolder,
          connectionStatus: h.connectionStatus,
          sessionHealthState: h.sessionHealthState,
          tokenStatus: h.tokenStatus,
          enabled: acc.enabled,
          loginTime: h.loginTime,
          lastSync: h.lastHeartbeat,
          connectedSince: h.connectionTime,
        };
      }),
    );

    const subByStrategy = new Map(subs.map((s) => [s.strategyId, s]));
    const subscriptions = follows.map((f) => {
      const sub = subByStrategy.get(f.strategyId);
      return {
        followerId: f.id,
        strategyId: f.strategyId,
        strategyName: f.strategy?.strategyName ?? null,
        strategyStatus: f.strategy?.status ?? null,
        subscriptionStatus: sub?.status ?? null,
        subscriptionDate: (sub?.startDate ?? f.createdAt)?.toISOString?.() ?? null,
        copyTradingEnabled: f.enabled,
        multiplier: f.multiplier,
        maximumLoss: f.maximumLoss,
        maximumDailyLoss: f.maximumDailyLoss,
      };
    });

    // Trading summary — reuse the permanent execution audit trail.
    const [grouped, lastResult] = await Promise.all([
      this.prisma.executionFollowerResult.groupBy({
        by: ['status'],
        where: { followerEmail: user.email },
        _count: { _all: true },
      }),
      this.prisma.executionFollowerResult.findFirst({
        where: { followerEmail: user.email },
        orderBy: { createdAt: 'desc' },
        select: { completedAt: true, createdAt: true },
      }),
    ]);
    const statusCount: Record<string, number> = {};
    let totalOrders = 0;
    for (const g of grouped) {
      statusCount[g.status] = g._count._all;
      totalOrders += g._count._all;
    }
    const lastTradeAt =
      (lastResult?.completedAt ?? lastResult?.createdAt)?.toISOString?.() ?? null;

    return {
      profile: {
        userId: user.id,
        fullName: user.name ?? null,
        email: user.email,
        // Fields not modelled in the current schema are honestly null →
        // the UI shows "Not provided".
        mobile: null,
        registrationDate: user.createdAt.toISOString(),
        accountStatus: user.isActive ? 'ACTIVE' : 'INACTIVE',
        lastLogin: null,
        lastActivity: lastTradeAt,
        country: null,
        subscriptionPlan: null,
      },
      brokerAccounts,
      subscriptions,
      trading: {
        totalOrders,
        successfulOrders: statusCount['SUCCESS'] ?? 0,
        failedOrders: statusCount['FAILED'] ?? 0,
        skippedOrders: statusCount['SKIPPED'] ?? 0,
        lastTradeAt,
        // Live positions / P&L require per-account broker calls and are
        // wired in a future sprint — returned null (never fabricated).
        openPositions: null,
        currentPnl: null,
        lifetimePnl: null,
      },
    };
  }
}
