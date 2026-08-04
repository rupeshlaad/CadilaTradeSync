import { Module } from '@nestjs/common';

import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { CopyTradingModule } from '../copy-trading/copy-trading.module';

import { PositionRegistryService } from './position-registry.service';
import { PositionSynchronizationService } from './position-synchronization.service';
import { PositionLifecycleService } from './position-lifecycle.service';
import { PositionLifecycleController } from './position-lifecycle.controller';

/**
 * Sprint 5.3 — Position Lifecycle module.
 *
 * Composes the lifecycle manager, the position registry and the
 * follower synchronization engine. Imports CopyTradingModule so the
 * manager can delegate the very first COMPLETE_FILL on a new position
 * to the existing entry-trade fan-out.
 */
@Module({
  imports: [PrismaModule, EncryptionModule, CopyTradingModule],
  controllers: [PositionLifecycleController],
  providers: [
    PositionRegistryService,
    PositionSynchronizationService,
    PositionLifecycleService,
  ],
  exports: [
    PositionLifecycleService,
    PositionRegistryService,
  ],
})
export class PositionLifecycleModule {}
