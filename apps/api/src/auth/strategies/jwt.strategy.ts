import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.module';
import { getJwtSecret } from '../jwt.config';

interface JwtPayload {
  sub: string;
  email: string;
  role: string;
  iat?: number;
  exp?: number;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // No insecure fallback — throws at startup if JWT_SECRET is missing.
      secretOrKey: getJwtSecret(config),
    });
  }

  /**
   * Sprint 1 — Authentication now respects CURRENT account state, not just a
   * valid signature:
   *  - the user must still exist and be active (suspended-after-issuance is
   *    rejected);
   *  - tokens issued before the last password change are rejected
   *    (password reset / change revokes existing sessions).
   */
  async validate(payload: JwtPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        role: true,
        isActive: true,
        emailVerified: true,
        passwordChangedAt: true,
      },
    });

    if (!user) throw new UnauthorizedException('User no longer exists');
    if (!user.isActive) throw new UnauthorizedException('Account is disabled');
    // First authentication gate (backend-authoritative): an unverified account
    // cannot access any protected route, even with a valid signature. Existing
    // pre-migration users were backfilled emailVerified=true and pass here.
    if (!user.emailVerified) {
      throw new UnauthorizedException('Please verify your email before continuing');
    }

    if (user.passwordChangedAt && payload.iat) {
      const changedAtSec = Math.floor(user.passwordChangedAt.getTime() / 1000);
      if (payload.iat < changedAtSec) {
        throw new UnauthorizedException('Session expired, please sign in again');
      }
    }

    return {
      sub: user.id,
      email: user.email,
      role: user.role,
      isActive: user.isActive,
      emailVerified: user.emailVerified,
    };
  }
}
