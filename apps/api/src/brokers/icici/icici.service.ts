import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';

@Injectable()
export class ICICIDirectService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async saveSession(tradingAccountId: string, session: any, profile: any) {
    // Breeze API sessions are invalidated daily at midnight IST; persist the
    // expiry so the shared session-health engine can mark the token EXPIRED
    // and require a fresh login (Breeze has no refresh flow).
    const expiresAt = nextICICIExpiry();
    const now = new Date();

    await this.prisma.brokerSession.upsert({
      where: {
        tradingAccountId_broker: {
          tradingAccountId,
          broker: 'ICICI_DIRECT',
        },
      },
      update: {
        encryptedAccessToken: this.encryption.encrypt(session.access_token),
        userId: profile.userId,
        userName: profile.userName,
        expiresAt,
        loginTime: now,
      },
      create: {
        tradingAccountId,
        broker: 'ICICI_DIRECT',
        encryptedAccessToken: this.encryption.encrypt(session.access_token),
        userId: profile.userId,
        userName: profile.userName,
        expiresAt,
        loginTime: now,
      },
    });

    await this.prisma.tradingAccount.update({
      where: { id: tradingAccountId },
      data: { connectionStatus: 'CONNECTED', lastHeartbeat: now },
    });
  }
}

/**
 * Sprint 6.2.0 — Breeze API session tokens expire daily at midnight IST
 * (00:00 IST == 18:30 UTC of the previous day). Compute the next boundary so
 * the shared BrokerSession lifecycle can flag the token EXPIRED.
 */
function nextICICIExpiry(): Date {
  const d = new Date();
  const expiry = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 18, 30, 0),
  );
  if (expiry.getTime() <= d.getTime()) {
    expiry.setUTCDate(expiry.getUTCDate() + 1);
  }
  return expiry;
}
