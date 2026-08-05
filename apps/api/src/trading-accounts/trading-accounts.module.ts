import { Module } from '@nestjs/common';
import { TradingAccountsController } from './trading-accounts.controller';
import { TradingAccountsService } from './trading-accounts.service';
import { BrokersModule } from '../brokers/brokers.module';

@Module({
  // Sprint 6.1 — BrokersModule exports BrokerService, which powers the
  // follower-facing session-health + disconnect endpoints.
  imports: [BrokersModule],
  controllers: [TradingAccountsController],
  providers: [TradingAccountsService],
  exports: [TradingAccountsService],
})
export class TradingAccountsModule {}
