import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { TradingAccountsService } from '../trading-accounts/trading-accounts.service';
import { StrategiesService } from '../strategies/strategies.service';
import { FollowersService } from '../followers/followers.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import { UsersService } from '../users/users.service';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
export class AdminController {
  constructor(
    private readonly users: UsersService,
    private readonly tradingAccounts: TradingAccountsService,
    private readonly strategies: StrategiesService,
    private readonly followers: FollowersService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  @Get('users')
  async listUsers() {
    const users = await this.users.listAll();
    return users.map((u) => this.users.toPublic(u));
  }

  @Get('trading-accounts')
  listTradingAccounts() {
    return this.tradingAccounts.listAllForAdmin();
  }

  @Get('strategies')
  listStrategies() {
    return this.strategies.listAllForAdmin();
  }

  @Get('followers')
  listFollowers() {
    return this.followers.listAllForAdmin();
  }

  @Get('subscriptions')
  listSubscriptions() {
    return this.subscriptions.listAllForAdmin();
  }
}
