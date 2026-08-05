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
import { TradingAccountsService } from './trading-accounts.service';
import { CreateTradingAccountDto } from './dto/create-trading-account.dto';
import { UpdateTradingAccountDto } from './dto/update-trading-account.dto';
import { BrokerService } from '../brokers/broker.service';
import { PrismaService } from '../prisma/prisma.module';
import { AccountType } from '@prisma/client';

@Controller('trading-accounts')
@UseGuards(JwtAuthGuard)
export class TradingAccountsController {
  constructor(
    private readonly service: TradingAccountsService,
    // Sprint 6.1 — reuse the existing broker session engine (same
    // service that powers /admin/master-accounts/:id/disconnect and
    // /admin/master-accounts/:id/session-health) for the follower
    // portal. No parallel broker service is introduced.
    private readonly brokerService: BrokerService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  list(@Req() req: any) {
    return this.service.listMine(req.user.sub);
  }

  @Post()
  create(@Req() req: any, @Body() dto: CreateTradingAccountDto) {
    return this.service.create(req.user.sub, dto);
  }

  @Get(':id')
  get(@Req() req: any, @Param('id') id: string) {
    return this.service.get(req.user.sub, id);
  }

  @Patch(':id')
  update(@Req() req: any, @Param('id') id: string, @Body() dto: UpdateTradingAccountDto) {
    return this.service.update(req.user.sub, id, dto);
  }

  @Delete(':id')
  remove(@Req() req: any, @Param('id') id: string) {
    return this.service.remove(req.user.sub, id);
  }

  @Post(':id/enable')
  enable(@Req() req: any, @Param('id') id: string) {
    return this.service.setEnabled(req.user.sub, id, true);
  }

  @Post(':id/disable')
  disable(@Req() req: any, @Param('id') id: string) {
    return this.service.setEnabled(req.user.sub, id, false);
  }

  /**
   * Sprint 6.1 — Broker session-health probe for a follower's
   * trading account. Ownership is enforced before delegating to the
   * shared BrokerService (which handles the actual session lookup
   * and drift correction identically for masters and followers).
   */
  @Get(':id/session-health')
  async sessionHealth(@Req() req: any, @Param('id') id: string) {
    await this.assertOwnedFollowerAccount(req.user.sub, id);
    return this.brokerService.getSessionHealth(id);
  }

  /**
   * Sprint 6.1 — Disconnect broker session for a follower's trading
   * account. Reuses BrokerService.disconnect (delete broker session
   * row, mark TradingAccount DISCONNECTED, clear heartbeat).
   */
  @Post(':id/disconnect')
  async disconnect(@Req() req: any, @Param('id') id: string) {
    await this.assertOwnedFollowerAccount(req.user.sub, id);
    return this.brokerService.disconnect(id);
  }

  private async assertOwnedFollowerAccount(userId: string, id: string) {
    const acc = await this.prisma.tradingAccount.findUnique({
      where: { id },
      select: { userId: true, accountType: true },
    });
    if (!acc) throw new ForbiddenException('Trading account not accessible');
    if (acc.accountType !== AccountType.FOLLOWER) {
      throw new ForbiddenException('Not a follower trading account');
    }
    if (acc.userId !== userId) {
      throw new ForbiddenException('You do not own this trading account');
    }
  }
}
