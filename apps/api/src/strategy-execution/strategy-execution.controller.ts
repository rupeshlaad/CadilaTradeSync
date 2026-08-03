import {
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { StrategyExecutionService } from './strategy-execution.service';

@Controller('admin/strategy-execution')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class StrategyExecutionController {
  constructor(private readonly execution: StrategyExecutionService) {}

  @Post(':id/start')
  start(@Param('id') id: string) {
    return this.execution.startStrategy(id);
  }

  @Post(':id/pause')
  pause(@Param('id') id: string) {
    return this.execution.pauseStrategy(id);
  }

  @Post(':id/resume')
  resume(@Param('id') id: string) {
    return this.execution.resumeStrategy(id);
  }

  @Post(':id/stop')
  stop(@Param('id') id: string) {
    return this.execution.stopStrategy(id);
  }

  @Post(':id/validate')
  validate(@Param('id') id: string) {
    return this.execution.validateStrategy(id);
  }

  @Get(':id/status')
  status(@Param('id') id: string) {
    return this.execution.getExecutionStatus(id);
  }
}
