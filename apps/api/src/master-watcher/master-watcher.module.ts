import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { CopyTradingModule } from '../copy-trading/copy-trading.module';
import { MasterWatcherService } from './master-watcher.service';

@Module({
  imports: [
    PrismaModule,
    EncryptionModule,
    CopyTradingModule,
  ],
  providers: [MasterWatcherService],
  exports: [MasterWatcherService],
})
export class MasterWatcherModule {}