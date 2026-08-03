import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { TradeEventIntakeService } from './trade-event-intake.service';

/**
 * Read-only visibility into the trade-event intake pipeline.
 *
 * Deliberately NO write endpoints — this sprint delivers the foundation
 * only. Broker listeners feed the intake service in-process via
 * `TradeEventIntakeService.ingest()`, not via HTTP.
 */
@Controller('admin/trade-events')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class TradeEventIntakeController {
  constructor(private readonly intake: TradeEventIntakeService) {}

  @Get('summary')
  summary() {
    return this.intake.getPipelineSummary();
  }

  @Get('recent')
  recent(@Query('limit') limit?: string) {
    const n = limit ? Number(limit) : 20;
    return {
      items: this.intake.getRecent(Number.isFinite(n) ? n : 20),
    };
  }

  @Get('latest')
  latest() {
    return { record: this.intake.getLatest() };
  }
}
