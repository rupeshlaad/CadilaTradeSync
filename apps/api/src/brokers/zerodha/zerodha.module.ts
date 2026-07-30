import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EncryptionModule } from '../../encryption/encryption.module';
import { ZerodhaController } from './zerodha.controller';
import { ZerodhaService } from './zerodha.service';

@Module({
  imports: [
    PrismaModule,
    EncryptionModule,
  ],
  controllers: [ZerodhaController],
  providers: [ZerodhaService],
})
export class ZerodhaModule {}