import { Global, Module } from '@nestjs/common';
import { EligibilityService } from './eligibility.service';
import { EligibilityController } from './eligibility.controller';

/**
 * Global so any module (followers activation gate, onboarding) can inject the
 * single EligibilityService without re-wiring providers.
 */
@Global()
@Module({
  providers: [EligibilityService],
  controllers: [EligibilityController],
  exports: [EligibilityService],
})
export class EligibilityModule {}
