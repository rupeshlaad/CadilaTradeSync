import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { SubscriptionStatus } from '@prisma/client';
import { UpdateSubscriptionDto } from './dto/update-subscription.dto';

@Injectable()
export class SubscriptionsService {
  constructor(private readonly prisma: PrismaService) {}

  private serialize(row: any) {
    return {
      ...row,
      startDate: row.startDate?.toISOString?.() ?? row.startDate,
      endDate: row.endDate ? row.endDate.toISOString?.() ?? row.endDate : null,
      createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
      updatedAt: row.updatedAt?.toISOString?.() ?? row.updatedAt,
    };
  }

  async listMine(userId: string) {
    const rows = await this.prisma.subscription.findMany({
      where: { followerUserId: userId },
      orderBy: { createdAt: 'desc' },
      include: { strategy: { select: { strategyName: true, visibility: true } } },
    });
    return rows.map((r) => this.serialize(r));
  }

  async cancel(userId: string, id: string) {
    const sub = await this.prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw new NotFoundException();
    if (sub.followerUserId !== userId) throw new ForbiddenException();
    const updated = await this.prisma.subscription.update({
      where: { id },
      data: { status: SubscriptionStatus.CANCELLED, endDate: new Date() },
    });
    return this.serialize(updated);
  }

  async update(userId: string, id: string, dto: UpdateSubscriptionDto) {
    const sub = await this.prisma.subscription.findUnique({ where: { id } });
    if (!sub) throw new NotFoundException();
    if (sub.followerUserId !== userId) throw new ForbiddenException();
    const updated = await this.prisma.subscription.update({
      where: { id },
      data: {
        status: dto.status ?? undefined,
        endDate: dto.endDate ? new Date(dto.endDate) : undefined,
      },
    });
    return this.serialize(updated);
  }

  async listAllForAdmin() {
    const rows = await this.prisma.subscription.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        strategy: { select: { strategyName: true, visibility: true } },
        followerUser: { select: { email: true, name: true } },
      },
    });
    return rows.map((r) => this.serialize(r));
  }
}
