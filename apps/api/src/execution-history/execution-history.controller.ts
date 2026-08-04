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

import { ExecutionHistoryService } from './execution-history.service';

/**
 * Read-only admin API over the permanent copy-trading audit trail.
 *
 * `/admin/execution-history/summary` MUST be declared BEFORE the
 * `:id` route so Nest matches `summary` as a literal segment first.
 */
@Controller('admin/execution-history')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class ExecutionHistoryController {
  constructor(private readonly service: ExecutionHistoryService) {}

  @Get('summary')
  summary() {
    return this.service.summary();
  }

  @Get()
  list(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('strategy') strategy?: string,
    @Query('broker') broker?: string,
    @Query('symbol') symbol?: string,
    @Query('status') status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('search') search?: string,
    @Query('sort') sort?: string,
  ) {
    return this.service.list({
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      strategy: strategy?.trim() || undefined,
      broker: broker?.trim() || undefined,
      symbol: symbol?.trim() || undefined,
      status: status?.trim() || undefined,
      dateFrom: dateFrom?.trim() || undefined,
      dateTo: dateTo?.trim() || undefined,
      search: search?.trim() || undefined,
      sort: sort?.trim() || undefined,
    });
  }

  @Get(':id')
  async byId(@Param('id') id: string) {
    const row = await this.service.getById(id);
    if (!row) throw new NotFoundException(`Execution ${id} not found`);
    return row;
  }
}
