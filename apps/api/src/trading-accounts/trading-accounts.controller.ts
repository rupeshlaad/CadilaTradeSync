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
   * Sprint 6.1.2 — Live broker-account verification for a follower's trading
   * account. Retrieves broker account information through the existing broker
   * adapter (profile / entitlements / funds) so the follower can confirm CTS
   * is truly linked immediately after OAuth. Reuses the shared BrokerService.
   */
  @Get(':id/broker-info')
  async brokerInfo(@Req() req: any, @Param('id') id: string) {
    await this.assertOwnedFollowerAccount(req.user.sub, id);
    return this.brokerService.getBrokerInfo(id);
  }

  /**
   * Sprint 6.1.5 — Full SDK-driven operational dashboard (profile, funds,
   * holdings, positions, orders, trades, portfolio) for a follower account.
   * Reuses the shared BrokerService — identical engine to the Master Portal.
   */
  @Get(':id/dashboard')
  async dashboard(@Req() req: any, @Param('id') id: string) {
    await this.assertOwnedFollowerAccount(req.user.sub, id);
    return this.brokerService.getBrokerDashboard(id);
  }

  /**
   * Sprint 6.1.5 — Granular per-section live refresh. Calls exactly one broker
   * SDK method (no cached data), capability-aware.
   */
  @Get(':id/section/:section')
  async section(
    @Req() req: any,
    @Param('id') id: string,
    @Param('section') section: string,
  ) {
    await this.assertOwnedFollowerAccount(req.user.sub, id);
    const allowed = ['profile', 'funds', 'holdings', 'positions', 'orders', 'trades'];
    if (!allowed.includes(section)) {
      throw new ForbiddenException('Unknown broker section');
    }
    return this.brokerService.getBrokerSection(id, section as any);
  }

  /**
   * Sprint 6.1.5 — Broker capability/onboarding catalog for capability-driven
   * rendering and the dynamic onboarding form. Static, no account needed.
   */
  @Get('meta/broker-catalog')
  brokerCatalog() {
    return this.brokerService.brokerCatalog();
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
