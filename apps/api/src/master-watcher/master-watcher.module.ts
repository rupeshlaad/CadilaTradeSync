import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { PositionLifecycleModule } from '../position-lifecycle/position-lifecycle.module';
import { BrokersModule } from '../brokers/brokers.module';
import { MasterWatcherService } from './master-watcher.service';
import { MasterSyncController } from './master-sync.controller';

@Module({
  imports: [
    PrismaModule,
    EncryptionModule,
    PositionLifecycleModule,
    BrokersModule,
  ],
  controllers: [MasterSyncController],
  providers: [MasterWatcherService],
  exports: [MasterWatcherService],
})
export class MasterWatcherModule {}
