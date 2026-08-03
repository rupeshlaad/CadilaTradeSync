import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { CreateStrategyDto } from './dto/create-strategy.dto';
import { UpdateStrategyDto } from './dto/update-strategy.dto';
import {
  AccountType,
  Prisma,
  Visibility,
} from '@prisma/client';

@Injectable()
export class StrategiesService {
  constructor(private readonly prisma: PrismaService) {}

  private serialize(row: any) {
    return {
      ...row,
      createdAt: row.createdAt?.toISOString?.() ?? row.createdAt,
      updatedAt: row.updatedAt?.toISOString?.() ?? row.updatedAt,
      followerCount: row._count?.followers,
    };
  }

  async listMine(userId: string) {
    const rows = await this.prisma.strategy.findMany({
      where: { tradingAccount: { userId } },
      orderBy: { createdAt: 'desc' },
      include: {
        tradingAccount: { select: { nickname: true, broker: true } },
        _count: { select: { followers: true } },
      },
    });
    return rows.map((r) => this.serialize(r));
  }

  async marketplace() {
    const rows = await this.prisma.strategy.findMany({
      where: { visibility: Visibility.PUBLIC, enabled: true },
      orderBy: { createdAt: 'desc' },
      include: {
        tradingAccount: { select: { nickname: true, broker: true } },
        _count: { select: { followers: true } },
      },
    });
    return rows.map((r) => this.serialize(r));
  }

  private async assertOwnership(userId: string, tradingAccountId: string) {
    const acc = await this.prisma.tradingAccount.findUnique({ where: { id: tradingAccountId } });
    if (!acc) throw new NotFoundException('Trading account not found');
    if (acc.userId !== userId) throw new ForbiddenException('You do not own this trading account');
    return acc;
  }

  async create(userId: string, dto: CreateStrategyDto) {
    await this.assertOwnership(userId, dto.tradingAccountId);

    const account = await this.prisma.tradingAccount.findUnique({
      where: {
        id: dto.tradingAccountId,
      },
    });

    if (!account) {
      throw new NotFoundException('Trading account not found');
    }

    if (account.accountType !== AccountType.MASTER) {
      throw new ForbiddenException(
        'Strategies can only be created for Master accounts.',
      );
    }

    const row = await this.prisma.strategy.create({
      data: {
        tradingAccountId: dto.tradingAccountId,
        strategyName: dto.strategyName,
        description: dto.description ?? null,
        visibility: dto.visibility ?? Visibility.PRIVATE,
        masterAccount: true,
        baseQuantity: dto.baseQuantity ?? 1,
        maxFollowers: dto.maxFollowers ?? 0,
        status: dto.status ?? 'ACTIVE',
        enabled: dto.enabled ?? true,
      },
      include: {
        tradingAccount: {
          select: {
            nickname: true,
            broker: true,
          },
        },
        _count: {
          select: {
            followers: true,
          },
        },
      },
    });

    return this.serialize(row);
  }

  private async findOwnedStrategy(userId: string, id: string) {
    const row = await this.prisma.strategy.findUnique({ where: { id }, include: { tradingAccount: true } });
    if (!row) throw new NotFoundException('Strategy not found');
    if (row.tradingAccount.userId !== userId) throw new ForbiddenException();
    return row;
  }

  async get(userId: string, id: string) {
    const row = await this.prisma.strategy.findUnique({
      where: { id },
      include: {
        tradingAccount: { select: { nickname: true, broker: true, userId: true } },
        _count: { select: { followers: true } },
      },
    });
    if (!row) throw new NotFoundException('Strategy not found');
    if (row.visibility !== Visibility.PUBLIC && row.tradingAccount.userId !== userId) {
      throw new ForbiddenException();
    }
    return this.serialize(row);
  }

  async update(userId: string, id: string, dto: UpdateStrategyDto) {
    await this.findOwnedStrategy(userId, id);
    const data: Prisma.StrategyUpdateInput = {};
    if (dto.strategyName !== undefined) data.strategyName = dto.strategyName;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.visibility !== undefined) data.visibility = dto.visibility;
    if (dto.masterAccount !== undefined) data.masterAccount = dto.masterAccount;
    if (dto.baseQuantity !== undefined) data.baseQuantity = dto.baseQuantity;
    if (dto.maxFollowers !== undefined) data.maxFollowers = dto.maxFollowers;
    if (dto.status !== undefined) data.status = dto.status;
    const row = await this.prisma.strategy.update({
      where: { id },
      data,
      include: {
        tradingAccount: { select: { nickname: true, broker: true } },
        _count: { select: { followers: true } },
      },
    });
    return this.serialize(row);
  }

  async remove(userId: string, id: string) {
    await this.findOwnedStrategy(userId, id);
    await this.prisma.strategy.delete({ where: { id } });
    return { ok: true };
  }

  async listAllForAdmin() {
    const rows = await this.prisma.strategy.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        tradingAccount: { select: { nickname: true, broker: true, user: { select: { email: true } } } },
        _count: { select: { followers: true } },
      },
    });
    return rows.map((r) => this.serialize(r));
  }

  async adminCreate(dto: CreateStrategyDto) {
    const row = await this.prisma.strategy.create({
      data: {
        tradingAccountId: dto.tradingAccountId,
        strategyName: dto.strategyName,
        description: dto.description ?? null,
        visibility: dto.visibility ?? Visibility.PRIVATE,
        masterAccount: true,
        baseQuantity: dto.baseQuantity ?? 1,
        maxFollowers: dto.maxFollowers ?? 0,
        status: dto.status ?? 'ACTIVE',
        enabled: dto.enabled ?? true,
      },
      include: {
        tradingAccount: {
          select: {
            nickname: true,
            broker: true,
            user: {
              select: {
                email: true,
              },
            },
          },
        },
        _count: {
          select: {
            followers: true,
          },
        },
      },
    });
    return this.serialize(row);
  }

  async adminUpdate(id: string, dto: UpdateStrategyDto) {
    return this.prisma.strategy.update({
      where: { id },
      data: dto,
    });
  }

  async adminDelete(id: string) {
    await this.prisma.strategy.delete({
      where: { id },
    });
    return {
      success: true,
    };
  }
}