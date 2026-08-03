import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
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

  @Get(':id/dashboard')
  async dashboard(@Param('id') id: string) {
    return this.brokerService.getDashboard(id);
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