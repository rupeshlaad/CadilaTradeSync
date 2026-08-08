import { Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { MasterWatcherService, MasterSyncResult } from './master-watcher.service';

/**
 * Sprint 6.2.12 — Manual "Sync Now" endpoint.
 *
 * Runs a single on-demand reconciliation cycle for one master account.
 * Replaces the removed continuous background poller: brokers are only
 * queried when the operator explicitly triggers a sync (or automatically
 * once after a successful CTS manual trade).
 */
@Controller('masters')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class MasterSyncController {
  constructor(private readonly watcher: MasterWatcherService) {}

  @Post(':id/sync')
  sync(@Param('id') id: string): Promise<MasterSyncResult> {
    return this.watcher.syncMaster(id);
  }
}
