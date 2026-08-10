import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EncryptionModule } from '../../encryption/encryption.module';
import { UpstoxController } from './upstox.controller';
import { UpstoxService } from './upstox.service';

@Module({
  imports: [PrismaModule, EncryptionModule],
  controllers: [UpstoxController],
  providers: [UpstoxService],
})
export class UpstoxModule {}
