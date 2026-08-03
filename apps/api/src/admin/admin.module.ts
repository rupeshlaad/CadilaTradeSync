import { Module } from '@nestjs/common';

import { UsersModule } from '../users/users.module';
import { TradingAccountsModule } from '../trading-accounts/trading-accounts.module';
import { StrategiesModule } from '../strategies/strategies.module';
import { FollowersModule } from '../followers/followers.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';

import { AdminController } from './admin.controller';
import { AdminStrategiesController } from './admin-strategies.controller';

@Module({
  imports: [
    UsersModule,
    TradingAccountsModule,
    StrategiesModule,
    FollowersModule,
    SubscriptionsModule,
  ],
  controllers: [
    AdminController,
    AdminStrategiesController,
  ],
})
export class AdminModule {}