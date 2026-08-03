import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { BrokersModule } from '../brokers/brokers.module';

import { StrategyExecutionService } from './strategy-execution.service';
import { StrategyExecutionController } from './strategy-execution.controller';

@Module({
  imports: [PrismaModule, BrokersModule],
  controllers: [StrategyExecutionController],
  providers: [StrategyExecutionService],
  exports: [StrategyExecutionService],
})
export class StrategyExecutionModule {}
