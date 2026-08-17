import { Module } from '@nestjs/common';
import { StrategiesController } from './strategies.controller';
import { StrategiesService } from './strategies.service';
import { TermsGuard } from '../auth/guards/terms.guard';

@Module({
  controllers: [StrategiesController],
  providers: [StrategiesService, TermsGuard],
  exports: [StrategiesService],
})
export class StrategiesModule {}
