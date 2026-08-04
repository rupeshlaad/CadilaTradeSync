import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

import { OrderActionsService } from './order-actions.service';
import {
  CancelOrderDto,
  ExitOrderDto,
  ModifyOrderDto,
} from './order-actions.dto';

/**
 * Sprint 5.5.1 — Admin Order Actions API.
 *
 *   POST /admin/orders/:key/modify   Modify an eligible master order
 *   POST /admin/orders/:key/cancel   Cancel an eligible master order
 *   POST /admin/orders/:key/exit     Square off an open master position
 *
 * `:key` accepts either the registry key
 * `{broker}:{masterAccountId}:{brokerOrderId}` or a bare broker order
 * id — the same fallback the read-only position lifecycle controller
 * uses. Every action flows through the existing PositionLifecycle
 * pipeline, which propagates to follower orders and records the
 * outcome in ExecutionHistory automatically.
 */
@Controller('admin/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class OrderActionsController {
  constructor(private readonly service: OrderActionsService) {}

  @Post(':key/modify')
  modify(@Param('key') key: string, @Body() dto: ModifyOrderDto) {
    return this.service.modify(key, dto);
  }

  @Post(':key/cancel')
  cancel(@Param('key') key: string, @Body() dto: CancelOrderDto) {
    return this.service.cancel(key, dto ?? ({} as CancelOrderDto));
  }

  @Post(':key/exit')
  exit(@Param('key') key: string, @Body() dto: ExitOrderDto) {
    return this.service.exit(key, dto ?? ({} as ExitOrderDto));
  }
}
