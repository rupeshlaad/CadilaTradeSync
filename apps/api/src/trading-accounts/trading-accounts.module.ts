import { Module } from '@nestjs/common';
import { TradingAccountsController } from './trading-accounts.controller';
import { TradingAccountsService } from './trading-accounts.service';
import { BrokersModule } from '../brokers/brokers.module';
import { TermsGuard } from '../auth/guards/terms.guard';

@Module({
  // Sprint 6.1 — BrokersModule exports BrokerService, which powers the
  // follower-facing session-health + disconnect endpoints.
  imports: [BrokersModule],
  controllers: [TradingAccountsController],
  providers: [TradingAccountsService, TermsGuard],
  exports: [TradingAccountsService],
})
export class TradingAccountsModule {}
