import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

import { PositionRegistryService } from './position-registry.service';
import { PositionRecord } from './lifecycle.types';

/**
 * Sprint 5.3 — read-only admin endpoints over the in-memory Position
 * Registry. These are consumed by the Trade Monitor UI (lifecycle
 * status + timeline section) and by future analytics work.
 *
 * These endpoints deliberately do NOT expose write access. Every
 * mutation to the registry happens as a side-effect of ingesting a
 * broker lifecycle event through `PositionLifecycleService.ingest`.
 */
@Controller('admin/position-lifecycle')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class PositionLifecycleController {
  constructor(private readonly registry: PositionRegistryService) {}

  @Get('positions')
  positions(@Query('status') status?: string) {
    const filter = status?.trim().toUpperCase();
    const source =
      filter === 'OPEN' ? this.registry.listOpen() : this.registry.list();
    return {
      count: source.length,
      items: source.map((p) => toSummary(p)),
    };
  }

  @Get('positions/:key')
  position(@Param('key') key: string) {
    // Client-side keys are `broker:accountId:orderId` — URL-decoded
    // by Nest for us. If the caller passes an ordinary segment we
    // still find it via direct lookup, otherwise we search by
    // brokerOrderId as a fallback (useful when Trade Monitor only
    // knows the broker order id from execution_history).
    let record = this.registry.get(key);
    if (!record) {
      const byOrderId = this.registry
        .list()
        .find((p) => p.brokerOrderId === key);
      if (byOrderId) record = byOrderId;
    }
    if (!record) {
      throw new NotFoundException(`Position ${key} not tracked`);
    }
    return toDetail(record);
  }
}

function toSummary(p: PositionRecord) {
  return {
    key: p.key,
    broker: p.broker,
    masterAccountId: p.masterAccountId,
    brokerOrderId: p.brokerOrderId,
    strategyId: p.strategyId,
    symbol: p.symbol,
    exchange: p.exchange,
    side: p.side,
    quantity: p.quantity,
    filledQuantity: p.filledQuantity,
    pendingQuantity: p.pendingQuantity,
    price: p.price,
    triggerPrice: p.triggerPrice,
    orderType: p.orderType,
    productType: p.productType,
    state: p.state,
    followerCount: p.followers.length,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    closedAt: p.closedAt,
  };
}

function toDetail(p: PositionRecord) {
  return {
    ...toSummary(p),
    followers: p.followers,
    timeline: [...p.timeline].sort((a, b) =>
      a.at < b.at ? -1 : a.at > b.at ? 1 : 0,
    ),
  };
}
