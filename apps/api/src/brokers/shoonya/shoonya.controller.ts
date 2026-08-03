import { Controller, Get, Query } from '@nestjs/common';
import { ShoonyaService } from './shoonya.service';

@Controller('brokers/shoonya')
export class ShoonyaController {
  constructor(
    private readonly shoonyaService: ShoonyaService,
  ) {}

  @Get('login')
  async login(
    @Query('tradingAccountId') tradingAccountId: string,
  ) {
    return this.shoonyaService.login(tradingAccountId);
  }
}