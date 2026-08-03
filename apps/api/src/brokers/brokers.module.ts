import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EncryptionModule } from '../encryption/encryption.module';
import { BrokerService } from './broker.service';

@Module({
  imports: [PrismaModule, EncryptionModule],
  providers: [BrokerService],
  exports: [BrokerService],
})
export class BrokersModule {}