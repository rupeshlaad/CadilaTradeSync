import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EncryptionModule } from '../../encryption/encryption.module';
import { ICICIDirectController } from './icici.controller';
import { ICICIDirectService } from './icici.service';

@Module({
  imports: [PrismaModule, EncryptionModule],
  controllers: [ICICIDirectController],
  providers: [ICICIDirectService],
  exports: [ICICIDirectService],
})
export class ICICIDirectModule {}
