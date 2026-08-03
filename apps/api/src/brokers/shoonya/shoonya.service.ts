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

    console.log({
      uid: account.clientId,
      vendorCode,
      apiKey,
      apiSecret,
      passwordHash,
      appKeyHash,
      otp,
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
        headers: err.response?.headers,
        data: err.response?.data,
      });

      throw new BadRequestException({
        broker: 'SHOONYA',
        message: 'Shoonya login failed',
        status: err.response?.status,
        reason: err.response?.data ?? err.message,
      });
    }

    const profile = await adapter.getProfile();

    await this.prisma.brokerSession.upsert({
      where: {
        tradingAccountId_broker: {
          tradingAccountId,
          broker: 'SHOONYA',
        },
      },
      update: {
        encryptedAccessToken: this.encryption.encrypt(
          session.susertoken,
        ),
        userId: profile.userId,
        userName: profile.userName,
      },
      create: {
        tradingAccountId,
        broker: 'SHOONYA',
        encryptedAccessToken: this.encryption.encrypt(
          session.susertoken,
        ),
        userId: profile.userId,
        userName: profile.userName,
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

    return {
      success: true,
      profile,
    };
  }
}