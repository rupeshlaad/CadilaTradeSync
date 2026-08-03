import { Module } from '@nestjs/common';
import { MasterAccountsController } from './master-accounts.controller';
import { MasterAccountsService } from './master-accounts.service';
import { BrokersModule } from '../brokers/brokers.module';

@Module({
  imports: [BrokersModule],
  controllers: [MasterAccountsController],
  providers: [MasterAccountsService],
  exports: [MasterAccountsService],
})
export class MasterAccountsModule {}