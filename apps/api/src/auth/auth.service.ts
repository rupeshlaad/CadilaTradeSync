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
import { webAppBaseUrl } from '../brokers/broker-callback-redirect';

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
    const emailVerificationSent = await this.dispatchVerification(user.id, user.email).catch(
      (e) => {
        this.logger.warn(`Verification dispatch failed for new user: ${String(e)}`);
        return false;
      },
    );

    // Sprint 1 remediation: email verification is the FIRST authentication
    // gate. Registration does NOT issue a session — the user must verify their
    // email and then sign in. The gate is therefore authoritative at the token
    // layer (no token ⇒ no access to any protected route or the dashboard).
    return {
      user: this.users.toPublic(user),
      emailVerified: user.emailVerified,
      // Honest signal for the UI: false when SMTP could not dispatch (dev/test).
      emailVerificationSent,
    };
  }

  async login(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.users.findByEmail(normalizedEmail);
    if (!user) throw new UnauthorizedException('Invalid credentials');
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new UnauthorizedException('Invalid credentials');
    if (!user.isActive) throw new UnauthorizedException('Account is disabled');
    // First authentication gate — unverified users cannot sign in.
    if (!user.emailVerified) {
      throw new UnauthorizedException('Please verify your email before signing in.');
    }
    return { ...this.issue(user), emailVerified: user.emailVerified };
  }

  // ---------------- Email verification ----------------

  private async dispatchVerification(userId: string, email: string): Promise<boolean> {
    const raw = await this.tokens.issue(userId, AuthTokenPurpose.EMAIL_VERIFICATION, VERIFICATION_TTL_MS);
    const link = `${this.webBaseUrl()}/verify-email?token=${encodeURIComponent(raw)}`;
    const { delivered } = await this.mail.sendVerificationEmail(email, link);
    return delivered;
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
    // emailConfigured is global server state (not account-specific) so it does
    // not enable enumeration, but lets the UI be honest in dev/test.
    return { ...GENERIC_EMAIL_RESPONSE, emailConfigured: this.mail.isConfigured() };
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
    return { ...GENERIC_EMAIL_RESPONSE, emailConfigured: this.mail.isConfigured() };
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
    // Bumps passwordChangedAt → revokes ALL existing sessions, including the
    // caller's current token. The client MUST sign in again with the new
    // password (frontend redirects to login). We intentionally do NOT re-issue
    // a session here, so the security guarantee is not weakened.
    await this.users.setPassword(userId, hash);
    return {
      ok: true,
      message: 'Your password has been changed. Please sign in again.',
    };
  }

  // ---------------- Terms / consent ----------------

  currentTermsVersion(): string {
    return this.config.get<string>('TERMS_VERSION', '1.0');
  }

  /**
   * Returns the current terms version + display content for the acceptance
   * dialog. Content is configurable via TERMS_CONTENT; otherwise a concise
   * default Terms of Service is used, aligned with the Kamal Securities /
   * Candila FinTech legal documents (linked within the text).
   */
  currentTerms(): { version: string; content: string } {
    const version = this.currentTermsVersion();
    const content =
      this.config.get<string>('TERMS_CONTENT') ??
      `Candila TradeSync — Terms of Service (Version ${version})
Operated by Candila FinTech, powered by Candila Capital Pvt. Ltd.

1. The Platform. Candila TradeSync is a multi-broker copy-trading platform that lets you connect broker accounts and mirror trades. By accepting, you agree to these Terms together with our Privacy Policy, Disclaimer and Terms of Use.

2. Account Security. You are responsible for keeping your login credentials confidential and for all activity under your account. You must provide accurate information and use the platform only for lawful purposes.

3. Broker Connectivity & Authorization. You authorise Candila TradeSync to connect to the broker accounts you link and to place orders on your behalf according to your copy-trading configuration. You remain the owner of, and are responsible for, your broker accounts and their credentials.

4. Copy Trading & Market Risk. Trading in financial markets involves substantial risk, including the possible loss of capital. Past performance does not guarantee future results. You are solely responsible for your trading decisions, strategy selections and risk settings.

5. No Guarantees. We do not guarantee any profit, return, order execution, data accuracy, or uninterrupted or error-free availability of the service. Nothing on the platform constitutes investment, financial, legal or tax advice.

6. Third-Party Brokers & Services. The platform relies on third-party brokers, market-data and infrastructure providers. We are not responsible for their availability, actions, delays or decisions, including order rejections or account restrictions.

7. Service Limitations & Changes. We may modify, suspend, limit or discontinue any feature at any time. We may suspend or terminate access for breach of these Terms, suspected misuse, or where required by law, a broker or a regulator.

8. Limitation of Liability. To the maximum extent permitted by applicable law, Candila FinTech, Candila Capital Pvt. Ltd. and their affiliates shall not be liable for any direct, indirect, incidental, consequential or special damages, or for any trading losses, arising from use of the platform.

9. Privacy & Compliance. Your information is handled in accordance with our Privacy Policy. You are responsible for ensuring compliance with the laws and regulations applicable in your jurisdiction.

10. Governing Law. These Terms are governed by the laws of India and are subject to the jurisdiction of the competent courts in India.

Full legal documents:
- Terms of Use: https://kamalsecurities.com/terms-of-use
- Disclaimer: https://kamalsecurities.com/disclaimer
- Privacy Policy: https://kamalsecurities.com/privacy-policy

By ticking the box and selecting "I Accept", you acknowledge that you have read, understood and agree to these Terms of Service (Version ${version}).`;
    return { version, content };
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
    // Authoritative Web frontend base URL uses the EXISTING CTS convention
    // (WEB_APP_URL), shared with broker callback redirects, so auth email links
    // match the deployment. Falls back to localhost only when WEB_APP_URL is
    // unset. The legacy APP_WEB_URL variable is intentionally NOT used.
    return webAppBaseUrl();
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
