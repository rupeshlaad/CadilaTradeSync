import {
  Injectable,
  Logger,
  OnModuleInit,
  BadRequestException,
} from '@nestjs/common';
import { Prisma, Broker } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';
import { ExecutionEventRecorderService } from '../copy-trading/execution-event.recorder';
import type {
  ExecutionEvent,
  FollowerExecution,
} from '../copy-trading/execution-event';
import {
  traceStage,
  currentManualTradeTrace,
} from '../observability/manual-trade-trace';

// ---------------------------------------------------------------------------
// Query DTOs
// ---------------------------------------------------------------------------

export interface ListExecutionHistoryQuery {
  page?: number;
  limit?: number;
  strategy?: string;
  broker?: string;
  symbol?: string;
  status?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sort?: string; // e.g. "timestamp:desc", "processingTimeMs:asc"
}

export interface ExecutionHistorySummaryDto {
  today: {
    trades: number;
    successful: number;
    failed: number;
    partial: number;
    noStrategy: number;
    noFollowers: number;
    errors: number;
    successPercent: number;
    failurePercent: number;
    followersExecuted: number;
    avgProcessingTimeMs: number | null;
  };
  topFailureReasons: Array<{
    failureType: string;
    count: number;
  }>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/**
 * Sprint 5.2 — permanent operational audit trail for CopyTradingService.
 *
 * Subscribes to the in-memory ExecutionEventRecorderService (single
 * source of truth for a fan-out invocation) and mirrors every committed
 * event into two Postgres tables:
 *
 *   execution_history          — one row per handleTrade() invocation
 *   execution_follower_results — one row per follower attempt
 *
 * Never overwrites history. Never mutates existing rows. Writes happen
 * fire-and-forget from the recorder — persistence failures are logged
 * but never surface into the copy-trading control flow.
 */
@Injectable()
export class ExecutionHistoryService implements OnModuleInit {
  private readonly logger = new Logger(ExecutionHistoryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly recorder: ExecutionEventRecorderService,
  ) {}

  onModuleInit() {
    this.recorder.onCommit(async (event) => {
      await this.persist(event);
    });
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  async persist(event: ExecutionEvent): Promise<string | null> {
    try {
      const counts = countFollowerOutcomes(event.followers);
      const status = deriveMasterStatus(event, counts);

      // Best-effort enrichment: derive exchange/segment from the
      // instrument-broker mapping using the SAME lookup key
      // CopyTradingService uses (broker + brokerSymbol). If nothing is
      // mapped yet, we still persist the row with null exchange/segment.
      const enrichment = await this.lookupInstrumentMeta(
        event.broker,
        event.symbol,
      ).catch(() => null);

      const history = await this.prisma.executionHistory.create({
        data: {
          timestamp: safeDate(event.timestamp) ?? new Date(),
          strategyId: event.strategyId,
          strategyName: event.strategyName,
          masterAccountId: event.masterAccountId,
          masterAccountName: event.masterAccountNickname,
          masterBroker: event.broker,
          masterSymbol: event.symbol,
          masterExchange: event.masterExchange ?? enrichment?.exchange ?? null,
          masterSegment: event.masterSegment ?? enrichment?.segment ?? null,
          masterSide: event.side,
          masterQuantity: event.quantity,
          masterPrice: event.price ?? null,
          orderType: event.orderType ?? null,
          productType: event.productType || null,
          tradeSource: event.tradeSource,
          status,
          totalFollowers: event.followers.length,
          successfulFollowers: counts.success,
          failedFollowers: counts.failed,
          skippedFollowers: counts.skipped,
          processingTimeMs: event.processingTimeMs ?? null,
          followers: {
            create: event.followers.map((f) => this.toFollowerRow(f)),
          },
        },
        select: { id: true },
      });

      this.logger.log(
        `Persisted execution ${history.id} (${event.broker} ${event.symbol} ${event.side} x${event.quantity}, status=${status}, followers=${event.followers.length})`,
      );

      // Stage 8 — execution saved to the permanent audit trail.
      const trace = currentManualTradeTrace();
      const isManual =
        !!trace &&
        !!event.masterBrokerOrderId &&
        event.masterBrokerOrderId === trace.ids.brokerOrderId;
      if (isManual && trace) trace.ids.executionHistoryId = history.id;
      traceStage(
        8,
        {
          component: 'ExecutionHistoryService',
          method: 'persist',
          output: { executionHistoryId: history.id, status },
          status: 'EXECUTION_SAVED',
          relatedIds: {
            executionHistoryId: history.id,
            executionEventId: event.id,
            brokerOrderId: event.masterBrokerOrderId,
          },
        },
        isManual,
      );
      return history.id;
    } catch (err: any) {
      // Never rethrow — persistence must not affect live copy trading.
      this.logger.error(
        `Failed to persist execution history for ${event.id}: ${err?.message ?? err}`,
      );
      traceStage(8, {
        component: 'ExecutionHistoryService',
        method: 'persist',
        output: { error: err?.message ?? String(err) },
        status: 'PERSIST_FAILED',
        relatedIds: {
          executionEventId: event.id,
          brokerOrderId: event.masterBrokerOrderId,
        },
      });
      return null;
    }
  }

  private toFollowerRow(f: FollowerExecution) {
    // brokerOrderId is best-effort extracted from the broker response
    // when the adapter reports it (Fyers returns { s:'ok', id: '...' }).
    const brokerOrderId = extractBrokerOrderId(f.brokerResponse);

    return {
      followerId: f.followerId,
      followerEmail: f.followerEmail,
      broker: f.broker,
      brokerOrderId,
      status: f.status,
      failureType: f.failureType,
      failureReason: f.reason,
      rawBrokerResponse:
        f.brokerResponse === undefined || f.brokerResponse === null
          ? Prisma.JsonNull
          : (f.brokerResponse as Prisma.InputJsonValue),
      followerSymbol: f.followerSymbol,
      executedQuantity: f.quantity ?? null,
      executedPrice: null,
      startedAt: safeDate(f.startedAt),
      completedAt: safeDate(f.completedAt),
    };
  }

  private async lookupInstrumentMeta(
    broker: string,
    brokerSymbol: string,
  ): Promise<{ exchange: string; segment: string } | null> {
    if (!isBrokerEnum(broker)) return null;
    const row = await this.prisma.instrumentBroker.findFirst({
      where: { broker: broker as Broker, brokerSymbol },
      select: {
        instrument: { select: { exchange: true, segment: true } },
      },
    });
    if (!row?.instrument) return null;
    return {
      exchange: row.instrument.exchange,
      segment: row.instrument.segment,
    };
  }

  // -------------------------------------------------------------------------
  // Queries (server-side pagination, filters, sort — no N+1)
  // -------------------------------------------------------------------------

  async list(query: ListExecutionHistoryQuery) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 200);
    const skip = (page - 1) * limit;

    const where: Prisma.ExecutionHistoryWhereInput = {};

    if (query.strategy) {
      where.OR = [
        { strategyId: query.strategy },
        { strategyName: { contains: query.strategy, mode: 'insensitive' } },
      ];
    }
    if (query.broker) where.masterBroker = query.broker;
    if (query.symbol)
      where.masterSymbol = { contains: query.symbol, mode: 'insensitive' };
    if (query.status) where.status = query.status;

    if (query.dateFrom || query.dateTo) {
      const range: Prisma.DateTimeFilter = {};
      const from = safeDate(query.dateFrom);
      const to = safeDate(query.dateTo);
      if (from) range.gte = from;
      if (to) range.lte = to;
      where.timestamp = range;
    }

    if (query.search) {
      const s = query.search.trim();
      where.AND = [
        {
          OR: [
            { masterSymbol: { contains: s, mode: 'insensitive' } },
            { strategyName: { contains: s, mode: 'insensitive' } },
            { masterAccountName: { contains: s, mode: 'insensitive' } },
            {
              followers: {
                some: {
                  OR: [
                    { followerEmail: { contains: s, mode: 'insensitive' } },
                    { brokerOrderId: { contains: s, mode: 'insensitive' } },
                  ],
                },
              },
            },
          ],
        },
      ];
    }

    const orderBy = this.parseSort(query.sort);

    const [total, items] = await this.prisma.$transaction([
      this.prisma.executionHistory.count({ where }),
      this.prisma.executionHistory.findMany({
        where,
        orderBy,
        skip,
        take: limit,
        // Grid needs summary numbers only — no follower join here to
        // avoid N+1 / large payloads. Detail row does that lookup.
        select: {
          id: true,
          timestamp: true,
          strategyId: true,
          strategyName: true,
          masterAccountId: true,
          masterAccountName: true,
          masterBroker: true,
          masterSymbol: true,
          masterExchange: true,
          masterSegment: true,
          masterSide: true,
          masterQuantity: true,
          masterPrice: true,
          orderType: true,
          productType: true,
          tradeSource: true,
          status: true,
          totalFollowers: true,
          successfulFollowers: true,
          failedFollowers: true,
          skippedFollowers: true,
          processingTimeMs: true,
          createdAt: true,
        },
      }),
    ]);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  async getById(id: string) {
    const row = await this.prisma.executionHistory.findUnique({
      where: { id },
      include: {
        followers: {
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!row) return null;
    return {
      ...row,
      timeline: buildTimeline(row),
    };
  }

  async summary(): Promise<ExecutionHistorySummaryDto> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    // 1) Master-side counters for today. Single grouped query.
    const grouped = await this.prisma.executionHistory.groupBy({
      by: ['status'],
      where: { timestamp: { gte: startOfDay } },
      _count: { _all: true },
    });

    const statusCounts: Record<string, number> = {};
    let trades = 0;
    for (const g of grouped) {
      statusCounts[g.status] = g._count._all;
      trades += g._count._all;
    }

    // 2) Follower counters + processing time — done in one aggregate.
    const agg = await this.prisma.executionHistory.aggregate({
      where: { timestamp: { gte: startOfDay } },
      _sum: {
        successfulFollowers: true,
        failedFollowers: true,
        skippedFollowers: true,
      },
      _avg: { processingTimeMs: true },
    });

    const successfulFollowers = agg._sum.successfulFollowers ?? 0;
    const failedFollowers = agg._sum.failedFollowers ?? 0;
    const skippedFollowers = agg._sum.skippedFollowers ?? 0;
    const followersExecuted =
      successfulFollowers + failedFollowers + skippedFollowers;

    const successful = statusCounts['COMPLETED'] ?? 0;
    const failed = statusCounts['FAILED'] ?? 0;
    const partial = statusCounts['PARTIAL'] ?? 0;
    const noStrategy = statusCounts['NO_STRATEGY'] ?? 0;
    const noFollowers = statusCounts['NO_FOLLOWERS'] ?? 0;
    const errors = statusCounts['ERROR'] ?? 0;

    // Success% is defined against trades that actually attempted a
    // fan-out (COMPLETED / PARTIAL / FAILED). No-strategy / no-followers
    // are excluded because they never reached broker execution.
    const denominator = successful + partial + failed;
    const successPercent =
      denominator === 0 ? 0 : Math.round((successful * 100) / denominator);
    const failurePercent =
      denominator === 0 ? 0 : Math.round((failed * 100) / denominator);

    // 3) Top failure reasons — grouped by failureType across today.
    const topFailures = await this.prisma.executionFollowerResult.groupBy({
      by: ['failureType'],
      where: {
        status: 'FAILED',
        createdAt: { gte: startOfDay },
        NOT: { failureType: null },
      },
      _count: { _all: true },
      orderBy: { _count: { failureType: 'desc' } },
      take: 5,
    });

    return {
      today: {
        trades,
        successful,
        failed,
        partial,
        noStrategy,
        noFollowers,
        errors,
        successPercent,
        failurePercent,
        followersExecuted,
        avgProcessingTimeMs:
          agg._avg.processingTimeMs === null
            ? null
            : Math.round(agg._avg.processingTimeMs),
      },
      topFailureReasons: topFailures
        .filter((r) => r.failureType)
        .map((r) => ({
          failureType: r.failureType as string,
          count: r._count._all,
        })),
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private parseSort(
    sort: string | undefined,
  ): Prisma.ExecutionHistoryOrderByWithRelationInput {
    const allowed = new Set([
      'timestamp',
      'createdAt',
      'processingTimeMs',
      'masterSymbol',
      'masterBroker',
      'status',
      'totalFollowers',
      'successfulFollowers',
      'failedFollowers',
    ]);
    const raw = (sort ?? 'timestamp:desc').trim();
    const [field, direction] = raw.split(':');
    if (!allowed.has(field)) {
      throw new BadRequestException(`Unsupported sort field: ${field}`);
    }
    const dir = direction === 'asc' ? 'asc' : 'desc';
    return { [field]: dir } as Prisma.ExecutionHistoryOrderByWithRelationInput;
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (no service state)
// ---------------------------------------------------------------------------

function countFollowerOutcomes(followers: FollowerExecution[]) {
  let success = 0;
  let failed = 0;
  let skipped = 0;
  for (const f of followers) {
    if (f.status === 'SUCCESS') success++;
    else if (f.status === 'FAILED') failed++;
    else if (f.status === 'SKIPPED') skipped++;
  }
  return { success, failed, skipped };
}

/**
 * Derive the master-level status column from the recorder outcome and
 * follower tally.
 */
function deriveMasterStatus(
  event: ExecutionEvent,
  counts: { success: number; failed: number; skipped: number },
): string {
  if (event.outcome === 'NO_ACTIVE_STRATEGY') return 'NO_STRATEGY';
  if (event.outcome === 'NO_ENABLED_FOLLOWERS') return 'NO_FOLLOWERS';
  if (event.outcome === 'ERROR') return 'ERROR';
  // FANNED_OUT
  const total = counts.success + counts.failed + counts.skipped;
  if (total === 0) return 'NO_FOLLOWERS';
  if (counts.failed === 0 && counts.skipped === 0) return 'COMPLETED';
  if (counts.success === 0) return 'FAILED';
  return 'PARTIAL';
}

function safeDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function isBrokerEnum(value: string): boolean {
  return (Object.values(Broker) as string[]).includes(value);
}

/**
 * Best-effort extraction of a broker-side order id from adapter responses.
 * - Fyers success shape: { s: 'ok', code: 1101, message: '...', id: 'x' }
 * - Zerodha shape (future): { order_id: '...' }
 * - Fallback: any `id` field, otherwise null.
 */
function extractBrokerOrderId(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  for (const key of ['order_id', 'orderId', 'orderid', 'id']) {
    const v = r[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}

/**
 * Compact chronological timeline of events for the detail view.
 * Purely derived from stored data — no additional DB reads.
 */
function buildTimeline(
  row: {
    timestamp: Date;
    status: string;
    createdAt: Date;
    followers: Array<{
      id: string;
      followerEmail: string | null;
      broker: string;
      status: string;
      failureType: string | null;
      startedAt: Date | null;
      completedAt: Date | null;
    }>;
  },
) {
  const timeline: Array<{
    at: string;
    kind: string;
    label: string;
  }> = [];
  timeline.push({
    at: row.timestamp.toISOString(),
    kind: 'MASTER_TRADE',
    label: 'Master trade received',
  });
  for (const f of row.followers) {
    if (f.startedAt) {
      timeline.push({
        at: f.startedAt.toISOString(),
        kind: 'FOLLOWER_STARTED',
        label: `Follower attempt started — ${f.followerEmail ?? f.broker}`,
      });
    }
    if (f.completedAt) {
      timeline.push({
        at: f.completedAt.toISOString(),
        kind:
          f.status === 'SUCCESS'
            ? 'FOLLOWER_SUCCESS'
            : f.status === 'FAILED'
            ? 'FOLLOWER_FAILED'
            : 'FOLLOWER_SKIPPED',
        label: `${f.status}${f.failureType ? ` (${f.failureType})` : ''} — ${
          f.followerEmail ?? f.broker
        }`,
      });
    }
  }
  timeline.push({
    at: row.createdAt.toISOString(),
    kind: 'PERSISTED',
    label: `Execution finalised with status ${row.status}`,
  });
  timeline.sort((a, b) => a.at.localeCompare(b.at));
  return timeline;
}
