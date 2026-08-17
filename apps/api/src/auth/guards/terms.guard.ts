import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';

/** Machine-readable code the frontend recognises to prompt Terms acceptance. */
export const TERMS_ACCEPTANCE_REQUIRED = 'TERMS_ACCEPTANCE_REQUIRED';

/**
 * Sprint 1 — Terms acceptance is the first TRADING/ONBOARDING gate.
 *
 * Runs AFTER JwtAuthGuard (which populates req.user). Server-side authoritative
 * gate: any broker-connection or strategy-configuration operation is rejected
 * with `TERMS_ACCEPTANCE_REQUIRED` until the user has accepted the Terms
 * (User.termsAcceptedAt is not null). This cannot be bypassed by direct API
 * calls or URL navigation — it is not merely a disabled button.
 *
 * It is intentionally SEPARATE from the email-verification gate and does not
 * touch the LIVE eligibility logic.
 */
@Injectable()
export class TermsGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const userId = req?.user?.sub;
    if (!userId) {
      // JwtAuthGuard should have run first; defensive only.
      throw new UnauthorizedException('Authentication required');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { termsAcceptedAt: true },
    });

    if (!user?.termsAcceptedAt) {
      throw new ForbiddenException({
        statusCode: 403,
        error: TERMS_ACCEPTANCE_REQUIRED,
        message:
          'Please read and accept the Terms of Service before continuing with broker setup and strategy configuration.',
      });
    }
    return true;
  }
}
