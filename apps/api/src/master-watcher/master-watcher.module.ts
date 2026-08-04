import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { PositionLifecycleModule } from '../position-lifecycle/position-lifecycle.module';
import { MasterWatcherService } from './master-watcher.service';

@Module({
  imports: [
    PrismaModule,
    EncryptionModule,
    PositionLifecycleModule,
  ],
  providers: [MasterWatcherService],
  exports: [MasterWatcherService],
})
export class MasterWatcherModule {}
