import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AuthTokenPurpose, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { UsersService } from '../users/users.service';
import { AuthTokenService } from './tokens/auth-token.service';
import { MailService } from '../mail/mail.service';

const BCRYPT_ROUNDS = 10;
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESET_TTL_MS = 60 * 60 * 1000; // 1h

/**
 * Generic response for account-enumeration-sensitive flows (forgot password,
 * resend verification). Wording never reveals whether an email is registered.
 */
const GENERIC_EMAIL_RESPONSE = {
  ok: true,
  message: 'If an account exists for that email, a message has been sent.',
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
    private readonly tokens: AuthTokenService,
    private readonly mail: MailService,
    private readonly config: ConfigService,
  ) {}

  // ---------------- Registration / Login ----------------

  async register(email: string, password: string, name?: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await this.users.findByEmail(normalizedEmail);
    if (existing) throw new ConflictException('Email already registered');

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await this.users.create({
      email: normalizedEmail,
      password: hash,
      name,
      role: Role.USER,
    });

    // Fire the verification email (best-effort — never blocks registration).
    await this.dispatchVerification(user.id, user.email).catch((e) =>
      this.logger.warn(`Verification dispatch failed for new user: ${String(e)}`),
    );

    // Authentication is granted (a session), but the account is NOT yet live
    // eligible — that is decided server-side by EligibilityService.
    return { ...this.issue(user), emailVerified: user.emailVerified };
  }

  async login(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.users.findByEmail(normalizedEmail);
    if (!user) throw new UnauthorizedException('Invalid credentials');
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('Account is disabled');
    return { ...this.issue(user), emailVerified: user.emailVerified };
  }

  // ---------------- Email verification ----------------

  private async dispatchVerification(userId: string, email: string) {
    const raw = await this.tokens.issue(userId, AuthTokenPurpose.EMAIL_VERIFICATION, VERIFICATION_TTL_MS);
    const link = `${this.webBaseUrl()}/verify-email?token=${encodeURIComponent(raw)}`;
    await this.mail.sendVerificationEmail(email, link);
  }

  async verifyEmail(token: string) {
    const userId = await this.tokens.consume(token, AuthTokenPurpose.EMAIL_VERIFICATION);
    if (!userId) {
      throw new BadRequestException('Invalid or expired verification link.');
    }
    await this.users.markEmailVerified(userId);
    return { ok: true, message: 'Email verified successfully.' };
  }

  async resendVerification(email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.users.findByEmail(normalizedEmail);
    // Only send when the account exists AND is still unverified — but always
    // return the same generic response (no enumeration).
    if (user && !user.emailVerified) {
      await this.dispatchVerification(user.id, user.email).catch((e) =>
        this.logger.warn(`Resend verification failed: ${String(e)}`),
      );
    }
    return GENERIC_EMAIL_RESPONSE;
  }

  // ---------------- Forgot / Reset password ----------------

  async forgotPassword(email: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.users.findByEmail(normalizedEmail);
    if (user) {
      const raw = await this.tokens.issue(user.id, AuthTokenPurpose.PASSWORD_RESET, RESET_TTL_MS);
      const link = `${this.webBaseUrl()}/reset-password?token=${encodeURIComponent(raw)}`;
      await this.mail.sendPasswordResetEmail(user.email, link).catch((e) =>
        this.logger.warn(`Reset dispatch failed: ${String(e)}`),
      );
    }
    // Identical response whether or not the email exists.
    return GENERIC_EMAIL_RESPONSE;
  }

  async resetPassword(token: string, newPassword: string) {
    const userId = await this.tokens.consume(token, AuthTokenPurpose.PASSWORD_RESET);
    if (!userId) {
      throw new BadRequestException('Invalid or expired reset link.');
    }
    const user = await this.users.findById(userId);
    // Disallow reusing the exact current password.
    const same = await bcrypt.compare(newPassword, user.password);
    if (same) {
      throw new BadRequestException('New password must be different from the current password.');
    }
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // Bumps passwordChangedAt → all previously issued JWTs are revoked.
    await this.users.setPassword(userId, hash);
    return { ok: true, message: 'Password has been reset. Please sign in.' };
  }

  // ---------------- Change password (authenticated) ----------------

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.users.findById(userId);
    const ok = await bcrypt.compare(currentPassword, user.password);
    if (!ok) throw new BadRequestException('Current password is incorrect.');
    const same = await bcrypt.compare(newPassword, user.password);
    if (same) {
      throw new BadRequestException('New password must be different from the current password.');
    }
    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await this.users.setPassword(userId, hash);
    // Re-issue a fresh session for the caller so they are not logged out by
    // the passwordChangedAt revocation they just triggered.
    const fresh = await this.users.findById(userId);
    return { ...this.issue(fresh), message: 'Password changed successfully.' };
  }

  // ---------------- Terms / consent ----------------

  currentTermsVersion(): string {
    return this.config.get<string>('TERMS_VERSION', '1.0');
  }

  async acceptTerms(userId: string, version?: string) {
    const v = version?.trim() || this.currentTermsVersion();
    const user = await this.users.acceptTerms(userId, v);
    return {
      ok: true,
      termsVersion: v,
      termsAcceptedAt: user.termsAcceptedAt?.toISOString() ?? null,
    };
  }

  // ---------------- helpers ----------------

  private webBaseUrl(): string {
    return this.config.get<string>('APP_WEB_URL', 'http://localhost:3000').replace(/\/+$/, '');
  }

  private issue(user: { id: string; email: string; role: Role }) {
    const payload = { sub: user.id, email: user.email, role: user.role };
    const accessToken = this.jwt.sign(payload);
    return {
      user: this.users.toPublic(user as any),
      tokens: { accessToken },
    };
  }
}
