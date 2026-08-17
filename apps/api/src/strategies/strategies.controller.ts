import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TermsGuard } from '../auth/guards/terms.guard';
import { StrategiesService } from './strategies.service';
import { CreateStrategyDto } from './dto/create-strategy.dto';
import { UpdateStrategyDto } from './dto/update-strategy.dto';

@Controller('strategies')
@UseGuards(JwtAuthGuard)
export class StrategiesController {
  constructor(private readonly service: StrategiesService) {}

  @Get()
  list(@Req() req: any) {
    return this.service.listMine(req.user.sub);
  }

  @Get('marketplace')
  marketplace() {
    return this.service.marketplace();
  }

  @Post()
  @UseGuards(TermsGuard)
  create(@Req() req: any, @Body() dto: CreateStrategyDto) {
    return this.service.create(req.user.sub, dto);
  }

  @Get(':id')
  get(@Req() req: any, @Param('id') id: string) {
    return this.service.get(req.user.sub, id);
  }

  @Get(':id/summary')
  summary(@Req() req: any, @Param('id') id: string) {
    return this.service.getSummary(req.user.sub, id);
  }

  @Patch(':id')
  @UseGuards(TermsGuard)
  update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateStrategyDto) {
    return this.service.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.service.remove(req.user.sub, id);
  }
}
