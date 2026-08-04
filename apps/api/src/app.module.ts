import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { EncryptionModule } from './encryption/encryption.module';
import { TradingAccountsModule } from './trading-accounts/trading-accounts.module';
import { StrategiesModule } from './strategies/strategies.module';
import { FollowersModule } from './followers/followers.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { AdminModule } from './admin/admin.module';
import { MasterAccountsModule } from './master-accounts/master-accounts.module';
import { ZerodhaModule } from './brokers/zerodha/zerodha.module';
import { FyersModule } from './brokers/fyers/fyers.module';
import { MasterWatcherModule } from './master-watcher/master-watcher.module';
import { InstrumentModule } from './instruments/instrument.module';
import { AdminDbModule } from './admin-db/admin-db.module';
import { ShoonyaModule } from './brokers/shoonya/shoonya.module';
import { BrokersModule } from './brokers/brokers.module';
import { StrategyExecutionModule } from './strategy-execution/strategy-execution.module';
import { TradeEventsModule } from './trade-events/trade-events.module';
import { ExecutionHistoryModule } from './execution-history/execution-history.module';
import { PositionLifecycleModule } from './position-lifecycle/position-lifecycle.module';
import { ManualTradingModule } from './manual-trading/manual-trading.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env'],
    }),
    PrismaModule,
    RedisModule,
    EncryptionModule,
    AuthModule,
    UsersModule,
    HealthModule,
    TradingAccountsModule,
    StrategiesModule,
    FollowersModule,
    SubscriptionsModule,
    AdminModule,
    MasterAccountsModule,
    ZerodhaModule,
    FyersModule,
    ShoonyaModule,
    MasterWatcherModule,
    InstrumentModule,
    AdminDbModule,
    BrokersModule,
    StrategyExecutionModule,
    TradeEventsModule,
    ExecutionHistoryModule,
    PositionLifecycleModule,
    ManualTradingModule,
  ],
})
export class AppModule {}
