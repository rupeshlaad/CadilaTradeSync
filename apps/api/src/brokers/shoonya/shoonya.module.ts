import { Module } from '@nestjs/common';
import { ShoonyaController } from './shoonya.controller';
import { ShoonyaService } from './shoonya.service';
import { PrismaModule } from '../../prisma/prisma.module';
import { EncryptionModule } from '../../encryption/encryption.module';

@Module({
  imports: [PrismaModule, EncryptionModule],
  controllers: [ShoonyaController],
  providers: [ShoonyaService],
  exports: [ShoonyaService],
})
export class ShoonyaModule {}