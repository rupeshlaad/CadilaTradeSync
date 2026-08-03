import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { AdminDbController } from './admin-db.controller';
import { AdminDbService } from './admin-db.service';

@Module({
  imports: [PrismaModule],
  controllers: [AdminDbController],
  providers: [AdminDbService],
})
export class AdminDbModule {}