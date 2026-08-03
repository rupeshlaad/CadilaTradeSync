import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { InstrumentModule } from '../instruments/instrument.module';
import { CopyTradingService } from './copy-trading.service';

@Module({
  imports: [
    PrismaModule,
    EncryptionModule,
    InstrumentModule,
  ],
  providers: [
    CopyTradingService,
  ],
  exports: [
    CopyTradingService,
  ],
})
export class CopyTradingModule {}