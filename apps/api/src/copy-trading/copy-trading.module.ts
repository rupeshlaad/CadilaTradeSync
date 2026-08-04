import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { InstrumentModule } from '../instruments/instrument.module';
import { CopyTradingService } from './copy-trading.service';
import { ExecutionEventRecorderService } from './execution-event.recorder';
import { ExecutionEventsController } from './execution-events.controller';

@Module({
  imports: [
    PrismaModule,
    EncryptionModule,
    InstrumentModule,
  ],
  controllers: [
    ExecutionEventsController,
  ],
  providers: [
    ExecutionEventRecorderService,
    CopyTradingService,
  ],
  exports: [
    CopyTradingService,
    ExecutionEventRecorderService,
  ],
})
export class CopyTradingModule {}
