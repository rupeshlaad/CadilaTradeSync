import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
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
import { ICICIDirectModule } from './brokers/icici/icici.module';
import { UpstoxModule } from './brokers/upstox/upstox.module';
import { BrokersModule } from './brokers/brokers.module';
import { StrategyExecutionModule } from './strategy-execution/strategy-execution.module';
import { TradeEventsModule } from './trade-events/trade-events.module';
import { ExecutionHistoryModule } from './execution-history/execution-history.module';
import { PositionLifecycleModule } from './position-lifecycle/position-lifecycle.module';
import { ManualTradingModule } from './manual-trading/manual-trading.module';
import { OrderActionsModule } from './order-actions/order-actions.module';
import { FollowerModule } from './follower/follower.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Anchor the env file to the api package (…/apps/api/.env), resolved from
      // this compiled module's location, NOT from process.cwd(). The compiled
      // file lives at apps/api/dist/**, so `<dir>/../.env` → apps/api/.env
      // regardless of the working directory the process is started in
      // (Docker WORKDIR /app, `node dist/main.js` from the repo root, or
      // `pnpm --filter @cts/api start:prod`). The trailing cwd-relative '.env'
      // is kept as a backward-compatible fallback. This is why
      // process.env.UPSTOX_REDIRECT_URI (and every other var) was empty at
      // runtime while apps/api/.env existed on disk.
      envFilePath: [join(__dirname, '..', '.env'), '.env'],
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
    ICICIDirectModule,
    UpstoxModule,
    MasterWatcherModule,
    InstrumentModule,
    AdminDbModule,
    BrokersModule,
    StrategyExecutionModule,
    TradeEventsModule,
    ExecutionHistoryModule,
    PositionLifecycleModule,
    ManualTradingModule,
    OrderActionsModule,
    FollowerModule,
  ],
})
export class AppModule {}
