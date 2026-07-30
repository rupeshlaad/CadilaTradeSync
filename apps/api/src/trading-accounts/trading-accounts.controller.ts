import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TradingAccountsService } from './trading-accounts.service';
import { CreateTradingAccountDto } from './dto/create-trading-account.dto';
import { UpdateTradingAccountDto } from './dto/update-trading-account.dto';

@Controller('trading-accounts')
@UseGuards(JwtAuthGuard)
export class TradingAccountsController {
  constructor(private readonly service: TradingAccountsService) {}

  @Get()
  list(@Req() req: any) {
    return this.service.listMine(req.user.sub);
  }

  @Post()
  create(@Req() req: any, @Body() dto: CreateTradingAccountDto) {
    return this.service.create(req.user.sub, dto);
  }

  @Get(':id')
  get(@Req() req: any, @Param('id') id: string) {
    return this.service.get(req.user.sub, id);
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateTradingAccountDto) {
    return this.service.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.service.remove(req.user.sub, id);
  }

  @Post(':id/enable')
  enable(@Req() req: any, @Param('id') id: string) {
    return this.service.setEnabled(req.user.sub, id, true);
  }

  @Post(':id/disable')
  disable(@Req() req: any, @Param('id') id: string) {
    return this.service.setEnabled(req.user.sub, id, false);
  }
}
