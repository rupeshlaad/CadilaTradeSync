import { Controller, Get, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { EligibilityService } from './eligibility.service';

@Controller('eligibility')
@UseGuards(JwtAuthGuard)
export class EligibilityController {
  constructor(private readonly eligibility: EligibilityService) {}

  /** Server-authoritative LIVE eligibility for the current user. */
  @Get('me')
  async me(@Req() req: any) {
    return this.eligibility.evaluate(req.user.sub);
  }
}
