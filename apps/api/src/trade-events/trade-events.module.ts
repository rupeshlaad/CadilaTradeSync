import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { BrokersModule } from '../brokers/brokers.module';
import { StrategyExecutionModule } from '../strategy-execution/strategy-execution.module';

import { TradeEventNormalizationService } from './trade-event-normalization.service';
import { TradeEventValidationService } from './trade-event-validation.service';
import { TradeEventReadinessService } from './trade-event-readiness.service';
import { TradeEventIntakeService } from './trade-event-intake.service';
import { TradeEventIntakeController } from './trade-event-intake.controller';

@Module({
  imports: [PrismaModule, BrokersModule, StrategyExecutionModule],
  controllers: [TradeEventIntakeController],
  providers: [
    TradeEventNormalizationService,
    TradeEventValidationService,
    TradeEventReadinessService,
    TradeEventIntakeService,
  ],
  exports: [
    TradeEventNormalizationService,
    TradeEventValidationService,
    TradeEventReadinessService,
    TradeEventIntakeService,
  ],
})
export class TradeEventsModule {}
