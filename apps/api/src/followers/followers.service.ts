import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { SubscribeDto } from './dto/subscribe.dto';
import { UpdateFollowerDto } from './dto/update-follower.dto';
import { SubscriptionStatus, Visibility } from '@prisma/client';

@Injectable()
export class FollowersService {
  constructor(private readonly prisma: PrismaService) {}

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
}
