import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';

@Injectable()
export class ZerodhaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async saveSession(
    tradingAccountId: string,
    session: any,
    profile: any,
  ) {
    await this.prisma.brokerSession.upsert({
      where: {
        tradingAccountId_broker: {
          tradingAccountId,
          broker: 'ZERODHA',
        },
      },
      update: {
        encryptedAccessToken: this.encryption.encrypt(session.access_token),
        publicToken: session.public_token ?? null,
        userId: profile.userId,
        userName: profile.userName,
        loginTime: new Date(),
      },
      create: {
        tradingAccountId,
        broker: 'ZERODHA',
        encryptedAccessToken: this.encryption.encrypt(session.access_token),
        publicToken: session.public_token ?? null,
        userId: profile.userId,
        userName: profile.userName,
        loginTime: new Date(),
      },
    });

    await this.prisma.tradingAccount.update({
      where: {
        id: tradingAccountId,
      },
      data: {
        connectionStatus: 'CONNECTED',
      },
    });
  }
}