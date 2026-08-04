import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { PositionLifecycleModule } from '../position-lifecycle/position-lifecycle.module';

import { OrderActionsController } from './order-actions.controller';
import { OrderActionsService } from './order-actions.service';

/**
 * Sprint 5.5.1 — Admin Order Actions module.
 *
 * Composes the Modify / Cancel / Exit orchestrator that continues
 * through the existing PositionLifecycleService entry point. No
 * parallel execution pipeline; no follower-side controllers exposed.
 */
@Module({
  imports: [PrismaModule, EncryptionModule, PositionLifecycleModule],
  controllers: [OrderActionsController],
  providers: [OrderActionsService],
  exports: [OrderActionsService],
})
export class OrderActionsModule {}
