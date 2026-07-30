import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EncryptionModule } from '../../encryption/encryption.module';
import { FyersController } from './fyers.controller';
import { FyersService } from './fyers.service';

@Module({
  imports: [
    PrismaModule,
    EncryptionModule,
  ],
  controllers: [FyersController],
  providers: [FyersService],
})
export class FyersModule {}