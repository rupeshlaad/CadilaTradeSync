import { Controller, Get, Req, UseGuards } from '@nestjs/common';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { FollowerService } from './follower.service';

/**
 * Sprint 6.1 — Follower-scoped presentation endpoints.
 *
 *   GET /follower/onboarding-status  → shared OnboardingProgressWidget
 *   GET /follower/dashboard-summary  → FollowerDashboardHeader header
 *
 * User-scoped (JWT). No admin routes here — the admin experience
 * already has its own summary surface under /admin/**.
 */
@Controller('follower')
@UseGuards(JwtAuthGuard)
export class FollowerController {
  constructor(private readonly service: FollowerService) {}

  @Get('onboarding-status')
  onboarding(@Req() req: any) {
    return this.service.getOnboardingStatus(req.user.sub);
  }

  @Get('dashboard-summary')
  summary(@Req() req: any) {
    return this.service.getDashboardSummary(req.user.sub);
  }
}
