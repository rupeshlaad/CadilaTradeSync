import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { Transporter } from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Sprint 1 — Transactional mail abstraction.
 *
 * Callers depend only on `MailService`. When SMTP is configured via the
 * environment (SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/MAIL_FROM) a real
 * nodemailer SMTP transport is used (Hostinger, port 587 STARTTLS by default);
 * `delivered: true` is only returned after the SMTP submission succeeds. When
 * SMTP is NOT configured it degrades safely to a structured dev log and always
 * returns `delivered: false` — it never claims an email was sent.
 *
 * Security: SMTP credentials and password-reset/verification tokens are never
 * logged. On failure only a safe error code is logged.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter?: Transporter;

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

  /**
   * Lazily builds and caches a single reusable transporter. Built only when
   * SMTP is configured, so the API still boots normally without SMTP (dev).
   * Port 587 uses STARTTLS (secure=false, requireTLS=true); port 465 uses
   * implicit TLS. Certificate verification stays enabled.
   */
  private getTransporter(): Transporter {
    if (this.transporter) return this.transporter;

    const host = this.config.get<string>('SMTP_HOST')!;
    const port = Number(this.config.get<string>('SMTP_PORT', '587'));
    const user = this.config.get<string>('SMTP_USER');
    const pass = this.config.get<string>('SMTP_PASS');
    const secure = port === 465;

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      requireTLS: !secure, // enforce STARTTLS upgrade on 587
      auth: user && pass ? { user, pass } : undefined,
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 60_000,
      greetingTimeout: 30_000,
      socketTimeout: 300_000,
    });
    return this.transporter;
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

    try {
      const info = await this.getTransporter().sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
      });
      // Safe success log — no credentials, no token/link body.
      this.logger.log(
        `[MailService] Email dispatched to="${message.to}" subject="${message.subject}" messageId="${info?.messageId ?? 'n/a'}"`,
      );
      return { delivered: true };
    } catch (err: unknown) {
      // Never log the raw error (may contain connection/auth context) — only a
      // safe error code. Do not throw: auth flows stay resilient and simply
      // report delivered=false so the UI never claims a false success.
      this.logger.error(
        `[MailService] Email delivery failed to="${message.to}" code="${this.safeErrorCode(err)}"`,
      );
      return { delivered: false };
    }
  }

  private safeErrorCode(err: unknown): string {
    if (typeof err === 'object' && err !== null && 'code' in err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    return 'UNKNOWN';
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
