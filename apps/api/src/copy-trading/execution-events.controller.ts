import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

import { ExecutionEventRecorderService } from './execution-event.recorder';

/**
 * Read-only visibility into real copy-trading execution events.
 *
 * Every response is derived from the same in-memory ring buffer that
 * CopyTradingService writes to when it fans out a master trade to
 * followers, so counters and rows can never drift.
 */
@Controller('admin/execution-events')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class ExecutionEventsController {
  constructor(private readonly recorder: ExecutionEventRecorderService) {}

  @Get('summary')
  summary() {
    return this.recorder.getSummary();
  }

  @Get('recent')
  recent(@Query('limit') limit?: string) {
    const n = limit ? Number(limit) : 20;
    return {
      items: this.recorder.getRecent(Number.isFinite(n) ? n : 20),
    };
  }

  @Get(':id')
  byId(@Param('id') id: string) {
    return { event: this.recorder.getById(id) };
  }
}
