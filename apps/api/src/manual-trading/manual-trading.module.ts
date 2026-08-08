import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { BrokersModule } from '../brokers/brokers.module';
import { InstrumentModule } from '../instruments/instrument.module';
import { CopyTradingModule } from '../copy-trading/copy-trading.module';
import { PositionLifecycleModule } from '../position-lifecycle/position-lifecycle.module';
import { MasterWatcherModule } from '../master-watcher/master-watcher.module';

import { ManualTradeService } from './manual-trade.service';
import { ManualTradeValidatorService } from './manual-trade-validator.service';
import { ManualTradeController } from './manual-trade.controller';

/**
 * Sprint 5.4 — Manual Trade Execution module.
 *
 * Wires the manual-trade validator, orchestrator and admin controller.
 * Explicitly imports:
 *   - InstrumentModule       → InstrumentResolverService
 *   - BrokersModule          → BrokerService.getSessionHealth
 *   - CopyTradingModule      → ExecutionEventRecorderService (for
 *                              correlation of the fan-out result back
 *                              to the manual-trade ledger)
 *   - PositionLifecycleModule → PositionLifecycleService.ingest as the
 *                               single entry point into the shared
 *                               execution pipeline used by broker-
 *                               detected trades.
 */
@Module({
  imports: [
    PrismaModule,
    EncryptionModule,
    BrokersModule,
    InstrumentModule,
    CopyTradingModule,
    PositionLifecycleModule,
    MasterWatcherModule,
  ],
  controllers: [ManualTradeController],
  providers: [ManualTradeValidatorService, ManualTradeService],
  exports: [ManualTradeService],
})
export class ManualTradingModule {}
