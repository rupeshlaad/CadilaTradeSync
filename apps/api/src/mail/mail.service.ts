import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Sprint 1 — Transactional mail abstraction.
 *
 * This is a REAL delivery seam, not a mock: callers depend only on
 * `MailService`. A production SMTP/provider transport is wired later through
 * the documented environment variables (SMTP_HOST, SMTP_PORT, SMTP_USER,
 * SMTP_PASS, MAIL_FROM). When no transport is configured (this env / local
 * dev) it degrades safely to a structured log so the verification / reset
 * flows are fully exercisable without introducing a paid provider or real
 * credentials. No secrets are logged.
 *
 * IMPORTANT: no email is actually dispatched here until a transport is
 * configured — clearly a pending configuration item, never claimed as sent.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(private readonly config: ConfigService) {}

  private get from(): string {
    return this.config.get<string>('MAIL_FROM', 'no-reply@cts.local');
  }

  private get transportConfigured(): boolean {
    return !!this.config.get<string>('SMTP_HOST');
  }

  /** Whether a real email transport is configured (drives honest UI/messaging). */
  isConfigured(): boolean {
    return this.transportConfigured;
  }

  async send(message: MailMessage): Promise<{ delivered: boolean }> {
    if (!this.transportConfigured) {
      // Safe dev/unconfigured fallback: log that a mail WOULD be sent.
      this.logger.warn(
        `[MailService] No SMTP transport configured — email NOT dispatched. ` +
          `to="${message.to}" subject="${message.subject}" from="${this.from}"`,
      );
      // The body contains the action link (which embeds a token). NEVER emit
      // it in production — only in non-production so local dev can follow the
      // flow. Production logs must never expose verification/reset tokens.
      if (process.env.NODE_ENV !== 'production') {
        this.logger.debug(`[MailService] (dev only) body:\n${message.text}`);
      }
      return { delivered: false };
    }

    // Transport wiring point. A nodemailer/provider transport is added in a
    // later infrastructure task; until then a configured-but-unimplemented
    // transport must fail loudly rather than silently drop mail.
    this.logger.error(
      `[MailService] SMTP_HOST is set but no transport implementation is wired yet. ` +
        `Configure the transport before enabling live email. to="${message.to}"`,
    );
    return { delivered: false };
  }

  async sendVerificationEmail(to: string, link: string): Promise<{ delivered: boolean }> {
    return this.send({
      to,
      subject: 'Verify your Candila TradeSync email',
      text:
        `Welcome to Candila TradeSync.\n\n` +
        `Please verify your email address by opening the link below:\n${link}\n\n` +
        `This link expires in 24 hours. If you did not create an account, ignore this email.`,
    });
  }

  async sendPasswordResetEmail(to: string, link: string): Promise<{ delivered: boolean }> {
    return this.send({
      to,
      subject: 'Reset your Candila TradeSync password',
      text:
        `We received a request to reset your Candila TradeSync password.\n\n` +
        `Reset it using the link below:\n${link}\n\n` +
        `This link expires in 1 hour and can be used once. ` +
        `If you did not request this, you can safely ignore this email.`,
    });
  }
}
