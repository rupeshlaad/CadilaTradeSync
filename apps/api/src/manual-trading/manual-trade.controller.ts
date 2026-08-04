import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

import { ManualTradeService } from './manual-trade.service';
import { PlaceManualTradeDto } from './manual-trade.dto';

/**
 * Sprint 5.4 — Manual Trade Execution admin API.
 *
 *   POST /admin/manual-trading/place    Place a new manual master trade
 *   GET  /admin/manual-trading/recent   Recent manual trades (in-memory)
 *   GET  /admin/manual-trading/:id      Single manual trade by id
 *
 * Every response mirrors the ManualTradeRecord shape defined in
 * `manual-trade.types.ts` so the Trade Monitor / Manual Trading UI
 * can render Pending → Accepted → Executing → Completed / Partial /
 * Failed transitions without any schema translation.
 */
@Controller('admin/manual-trading')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class ManualTradeController {
  constructor(private readonly service: ManualTradeService) {}

  @Post('place')
  place(@Body() dto: PlaceManualTradeDto) {
    return this.service.place(dto);
  }

  @Get('recent')
  recent(@Query('limit') limit?: string) {
    const n = limit ? Number(limit) : 20;
    return {
      items: this.service.listRecent(Number.isFinite(n) ? n : 20),
    };
  }

  @Get(':id')
  byId(@Param('id') id: string) {
    const record = this.service.get(id);
    if (!record) {
      throw new NotFoundException(`Manual trade ${id} not found`);
    }
    return record;
  }
}
