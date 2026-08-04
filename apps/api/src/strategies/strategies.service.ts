import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
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

  // ---------------------------------------------------------------------------
  // Sprint 6.0 — Strategy Intelligence Summary (presentation-only).
  //
  // Aggregates static profile fields + existing DB counts into a single
  // presentation payload consumed by the shared Strategy Intelligence
  // layout. Ownership / visibility rules mirror `get()` so a marketplace
  // caller can view PUBLIC strategies without owning them.
  //
  // Performance and risk fields are intentionally null in Phase 1 —
  // historical import and live analytics ship in future sprints; the
  // shared UI renders "Not Available" / "Data will be available after
  // performance import." based on these nulls.
  // ---------------------------------------------------------------------------
  async getSummary(
    userId: string | null,
    id: string,
    opts: { admin?: boolean } = {},
  ) {
    const row = await this.prisma.strategy.findUnique({
      where: { id },
      include: {
        tradingAccount: {
          select: {
            id: true,
            userId: true,
            broker: true,
            accountType: true,
            enabled: true,
            connectionStatus: true,
          },
        },
        _count: { select: { followers: true } },
      },
    });
    if (!row) throw new NotFoundException('Strategy not found');

    if (!opts.admin) {
      const isOwner = userId != null && row.tradingAccount.userId === userId;
      if (row.visibility !== Visibility.PUBLIC && !isOwner) {
        throw new ForbiddenException();
      }
    }

    const [activeSubscribers, activeFollowers] = await Promise.all([
      this.prisma.subscription.count({
        where: { strategyId: id, status: 'ACTIVE' },
      }),
      this.prisma.follower.count({
        where: { strategyId: id, enabled: true },
      }),
    ]);

    // "Active master accounts" reflects whether the backing MASTER
    // trading account is currently enabled and connected. Uses only
    // existing DB fields — no live probing.
    const activeMasterAccounts =
      row.tradingAccount.accountType === AccountType.MASTER &&
      row.tradingAccount.enabled &&
      row.tradingAccount.connectionStatus === 'CONNECTED'
        ? 1
        : 0;

    return {
      profile: {
        id: row.id,
        strategyName: row.strategyName,
        strategyCode: buildStrategyCode(row.id),
        description: row.description,
        status: row.status,
        visibility: row.visibility,
        // Risk level is not tracked on the Strategy row yet — kept
        // null so the UI shows "Not Available" without fabricating.
        riskLevel: null,
        supportedBrokers: [row.tradingAccount.broker],
        // Supported markets are not tracked on the row either.
        supportedMarkets: [],
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      overview: {
        activeSubscribers,
        activeMasterAccounts,
        activeFollowers,
        currentStatus: row.status,
      },
      performance: {
        todayReturn: null,
        weeklyReturn: null,
        monthlyReturn: null,
        overallReturn: null,
        winRate: null,
        totalTrades: null,
        capitalManaged: null,
        lastUpdated: null,
      },
      risk: {
        riskLevel: null,
        maxDrawdown: null,
        volatility: null,
        notes: [],
      },
      recentActivity: {
        items: [],
      },
    };
  }

  async adminGetSummary(id: string) {
    return this.getSummary(null, id, { admin: true });
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

  async adminUpdate(id: string, dto: UpdateStrategyDto & { tradingAccountId?: string }) {
    // Load current row so we can preserve FK values that the caller
    // did not explicitly change, and 404 cleanly if the strategy is gone.
    const existing = await this.prisma.strategy.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('Strategy not found');
    }

    // Build a whitelisted update payload. We do NOT spread `dto` into
    // Prisma directly: the admin controller currently types the body as
    // `any`, which bypasses the global ValidationPipe's whitelisting,
    // so untrusted keys (or empty strings) could otherwise reach the DB.
    const data: Prisma.StrategyUpdateInput = {};
    if (dto.strategyName !== undefined) data.strategyName = dto.strategyName;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    if (dto.visibility !== undefined) data.visibility = dto.visibility;
    if (dto.masterAccount !== undefined) data.masterAccount = dto.masterAccount;
    if (dto.baseQuantity !== undefined) data.baseQuantity = dto.baseQuantity;
    if (dto.maxFollowers !== undefined) data.maxFollowers = dto.maxFollowers;
    if (dto.status !== undefined) data.status = dto.status;

    // FK: tradingAccountId.
    //
    //  - undefined / null           → leave FK untouched (edit that
    //                                  didn't change the account).
    //  - empty string / whitespace  → treat as "unchanged" and NEVER
    //                                  forward to Prisma. This is the
    //                                  fix for P2003 caused by the UI
    //                                  submitting "" when the operator
    //                                  briefly hits the placeholder.
    //  - identical to existing      → skip, avoid a needless FK write.
    //  - different, valid UUID that
    //    references an existing
    //    TradingAccount             → connect() to the new account.
    //  - different, but no such
    //    TradingAccount             → 400 BadRequest with a meaningful
    //                                  message; never let Prisma raise
    //                                  P2003 to the frontend.
    if (dto.tradingAccountId !== undefined && dto.tradingAccountId !== null) {
      const candidate = String(dto.tradingAccountId).trim();
      if (candidate.length > 0 && candidate !== existing.tradingAccountId) {
        const target = await this.prisma.tradingAccount.findUnique({
          where: { id: candidate },
        });
        if (!target) {
          throw new BadRequestException(
            `Invalid tradingAccountId "${candidate}": no such trading account`,
          );
        }
        data.tradingAccount = { connect: { id: candidate } };
      }
    }

    return this.prisma.strategy.update({
      where: { id },
      data,
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

/**
 * Sprint 6.0 — Human-friendly strategy code derived from the uuid.
 * Deterministic + prefixless so the UI can reference "STR-XXXXXXXX"
 * without a schema change. Not meant to be unique-checked; only
 * presentation.
 */
function buildStrategyCode(id: string): string {
  const compact = id.replace(/-/g, '').toUpperCase();
  return `STR-${compact.slice(0, 8)}`;
}