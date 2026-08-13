import { Module } from '@nestjs/common';
import { BrokersModule } from '../brokers.module';
import { FollowerExecutionService } from './follower-execution.service';

/**
 * Sprint — dynamic broker execution for the copy-trading follower fan-out.
 * Wraps the existing Broker Factory (BrokerService, provided by BrokersModule)
 * with the standardized FollowerExecutionService. Additive: introduces no new
 * runtime dependency and touches no existing module wiring beyond being
 * imported by CopyTradingModule.
 */
@Module({
  imports: [BrokersModule],
  providers: [FollowerExecutionService],
  exports: [FollowerExecutionService],
})
export class BrokerExecutionModule {}
