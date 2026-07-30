import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { StrategiesModule } from '../strategies/strategies.module';
import { FollowersModule } from '../followers/followers.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [TradingAccountsModule, StrategiesModule, FollowersModule, SubscriptionsModule, UsersModule],
  controllers: [AdminController],
})
export class AdminModule {}
