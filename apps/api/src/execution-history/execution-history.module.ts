import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { CopyTradingModule } from '../copy-trading/copy-trading.module';

import { ExecutionHistoryService } from './execution-history.service';
import { ExecutionHistoryController } from './execution-history.controller';

/**
 * Sprint 5.2 — permanent execution audit persistence.
 *
 * Depends on CopyTradingModule for the in-memory ExecutionEventRecorderService
 * (single source of truth for a fan-out). This module simply subscribes to
 * every commit and mirrors it into Postgres.
 */
@Module({
  imports: [PrismaModule, CopyTradingModule],
  controllers: [ExecutionHistoryController],
  providers: [ExecutionHistoryService],
  exports: [ExecutionHistoryService],
})
export class ExecutionHistoryModule {}
