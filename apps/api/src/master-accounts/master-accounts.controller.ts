import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { MasterAccountsService } from './master-accounts.service';
import { CreateMasterAccountDto } from './dto/create-master-account.dto';
import { UpdateMasterAccountDto } from './dto/update-master-account.dto';
import { BrokerService } from '../brokers/broker.service';

@Controller('admin/master-accounts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class MasterAccountsController {
  constructor(
    private readonly service: MasterAccountsService,
    private readonly brokerService: BrokerService,
  ) {}

  @Get()
  list() {
    return this.service.listAll();
  }

  @Post()
  create(@Req() req: any, @Body() dto: CreateMasterAccountDto) {
    return this.service.create(req.user.sub, dto);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.service.get(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateMasterAccountDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post(':id/enable')
  enable(@Param('id') id: string) {
    return this.service.setEnabled(id, true);
  }

  @Post(':id/disable')
  disable(@Param('id') id: string) {
    return this.service.setEnabled(id, false);
  }

  /**
   * Sprint 6.2.4 — Master Portal now consumes the SAME normalized, SDK-driven
   * dashboard DTO as the Follower Portal (getBrokerDashboard, not the raw
   * getDashboard). One normalization pipeline → identical data in both
   * portals for every broker (no portal-specific mapping).
   */
  @Get(':id/dashboard')
  async dashboard(@Param('id') id: string) {
    return this.brokerService.getBrokerDashboard(id);
  }

  /**
   * Sprint 6.2.4 — Granular per-section live refresh, identical to the
   * Follower Portal endpoint. Same shared BrokerService, same normalizers.
   */
  @Get(':id/section/:section')
  async section(@Param('id') id: string, @Param('section') section: string) {
    const allowed = ['profile', 'funds', 'holdings', 'positions', 'orders', 'trades'];
    if (!allowed.includes(section)) {
      throw new ForbiddenException('Unknown broker section');
    }
    return this.brokerService.getBrokerSection(id, section as any);
  }

  @Get(':id/session-health')
  async sessionHealth(@Param('id') id: string) {
    return this.brokerService.getSessionHealth(id);
  }

  @Post(':id/disconnect')
  async disconnect(@Param('id') id: string) {
    return this.brokerService.disconnect(id);
  }
}