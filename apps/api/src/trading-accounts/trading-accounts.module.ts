import { Module } from '@nestjs/common';
import { TradingAccountsController } from './trading-accounts.controller';
import { TradingAccountsService } from './trading-accounts.service';

@Module({
  controllers: [TradingAccountsController],
  providers: [TradingAccountsService],
  exports: [TradingAccountsService],
})
export class TradingAccountsModule {}
