import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';
import { authenticator } from '@otplib/preset-default';
import CryptoJS from 'crypto-js';
import { ShoonyaAdapter } from './shoonya.adapter';

@Injectable()
export class ShoonyaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async login(tradingAccountId: string) {
    const account = await this.prisma.tradingAccount.findUnique({
      where: {
        id: tradingAccountId,
      },
    });

    if (!account) {
      throw new NotFoundException('Trading account not found');
    }

    const adapter = new ShoonyaAdapter();

    const apiKey = this.encryption.decrypt(account.encryptedApiKey!);
    const apiSecret = this.encryption.decrypt(account.encryptedApiSecret!);
    const password = this.encryption.decrypt(account.encryptedPassword!);
    const totpSecret = this.encryption.decrypt(account.encryptedTotpSecret!);

    const otp = authenticator.generate(totpSecret);

    const passwordHash = CryptoJS.SHA256(password).toString();
    const appKeyHash = CryptoJS.SHA256(
      `${account.clientId}|${apiSecret}`,
    ).toString();

    const vendorCode = this.encryption.decrypt(
      account.encryptedVendorCode!,
    );

    // Note: never log plaintext credentials. Redacted diagnostics only.
    console.log('Shoonya login attempt', {
      uid: account.clientId,
      vendorCode,
      hasApiKey: !!apiKey,
      hasAppKeyHash: !!appKeyHash,
      hasTotp: !!otp,
    });

    let session: any;

    try {
      session = await adapter.login({
        uid: account.clientId,
        pwd: passwordHash,
        factor2: otp,
        vc: vendorCode,
        appkey: appKeyHash,
      });
    } catch (err: any) {
      console.error('Shoonya Login Error:', {
        status: err.response?.status,
        data: err.response?.data ?? err.message,
      });

      throw new BadRequestException({
        broker: 'SHOONYA',
        message: 'Shoonya login failed',
        status: err.response?.status,
        reason: err.response?.data ?? err.message,
      });
    }

    // adapter.login() has cached susertoken + uid/actid, so profile works.
    const profile = await adapter.getProfile();

    // Noren sessions are invalidated daily; force re-login after ~06:00 IST
    // (00:30 UTC). This lets the shared session-health engine detect expiry.
    const expiresAt = nextShoonyaExpiry();
    const now = new Date();

    await this.prisma.brokerSession.upsert({
      where: {
        tradingAccountId_broker: {
          tradingAccountId,
          broker: 'SHOONYA',
        },
      },
      update: {
        encryptedAccessToken: this.encryption.encrypt(session.susertoken),
        userId: profile.userId,
        userName: profile.userName,
        expiresAt,
        loginTime: now,
      },
      create: {
        tradingAccountId,
        broker: 'SHOONYA',
        encryptedAccessToken: this.encryption.encrypt(session.susertoken),
        userId: profile.userId,
        userName: profile.userName,
        expiresAt,
        loginTime: now,
      },
    });

    await this.prisma.tradingAccount.update({
      where: {
        id: tradingAccountId,
      },
      data: {
        connectionStatus: 'CONNECTED',
        lastHeartbeat: now,
      },
    });

    return {
      success: true,
      profile,
    };
  }
}

/**
 * Sprint 6.1.7 — Shoonya/Noren access tokens expire daily. Compute the next
 * 06:00 IST (00:30 UTC) boundary so the shared BrokerSession lifecycle can
 * mark the token EXPIRED and require a fresh TOTP login.
 */
function nextShoonyaExpiry(): Date {
  const d = new Date();
  const expiry = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 30, 0),
  );
  if (expiry.getTime() <= d.getTime()) {
    expiry.setUTCDate(expiry.getUTCDate() + 1);
  }
  return expiry;
}