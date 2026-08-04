import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';

import { StrategiesService } from '../strategies/strategies.service';

@Controller('admin/strategies')
export class AdminStrategiesController {
  constructor(
    private readonly strategies: StrategiesService,
  ) {}

  @Get()
  findAll() {
    return this.strategies.listAllForAdmin();
  }

  @Get(':id/summary')
  summary(@Param('id') id: string) {
    return this.strategies.adminGetSummary(id);
  }

  @Post()
  create(@Body() dto: any) {
    return this.strategies.adminCreate(dto);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: any,
  ) {
    return this.strategies.adminUpdate(id, dto);
  }

  @Delete(':id')
  remove(
    @Param('id') id: string,
  ) {
    return this.strategies.adminDelete(id);
  }
}