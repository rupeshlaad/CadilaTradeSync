import { Module } from '@nestjs/common';
import { FollowersController } from './followers.controller';
import { FollowersService } from './followers.service';
import { BrokersModule } from '../brokers/brokers.module';
import { TermsGuard } from '../auth/guards/terms.guard';

@Module({
  // Sprint 6.1.4 — BrokersModule exports BrokerService, reused so the admin
  // follower overview can read broker session health (Master/Follower parity).
  imports: [BrokersModule],
  controllers: [FollowersController],
  providers: [FollowersService, TermsGuard],
  exports: [FollowersService],
})
export class FollowersModule {}
