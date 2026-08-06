import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.module';
import { EncryptionService } from '../encryption/encryption.service';
import { CreateMasterAccountDto } from './dto/create-master-account.dto';
import { UpdateMasterAccountDto } from './dto/update-master-account.dto';
import { AccountType, Prisma, TradingAccount } from '@prisma/client';

@Injectable()
export class MasterAccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enc: EncryptionService,
  ) {}

  private redact(acc: TradingAccount) {
    const {
      encryptedApiKey,
      encryptedApiSecret,
      encryptedVendorCode,
      encryptedPassword,
      encryptedTotpSecret,
      ...safe
    } = acc;
    return {
      ...safe,
      hasApiKey: !!encryptedApiKey,
      hasApiSecret: !!encryptedApiSecret,
      hasVendorCode: !!encryptedVendorCode,
      hasPassword: !!encryptedPassword,
      hasTotpSecret: !!encryptedTotpSecret,
      createdAt: safe.createdAt.toISOString(),
      updatedAt: safe.updatedAt.toISOString(),
      lastHeartbeat: safe.lastHeartbeat ? safe.lastHeartbeat.toISOString() : null,
    };
  }

  async listAll() {
    const rows = await this.prisma.tradingAccount.findMany({
      where: { accountType: AccountType.MASTER },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.redact(r));
  }

  async create(adminId: string, dto: CreateMasterAccountDto) {
    const created = await this.prisma.tradingAccount.create({
      data: {
        userId: adminId,
        accountType: AccountType.MASTER,
        broker: dto.broker,
        platform: dto.platform,
        nickname: dto.nickname,
        clientId: dto.clientId,
        encryptedApiKey: dto.apiKey ? this.enc.encrypt(dto.apiKey) : null,
        encryptedApiSecret: dto.apiSecret ? this.enc.encrypt(dto.apiSecret) : null,
        encryptedVendorCode: dto.vendorCode ? this.enc.encrypt(dto.vendorCode) : null,
        encryptedPassword: dto.password ? this.enc.encrypt(dto.password) : null,
        encryptedTotpSecret: dto.totpSecret ? this.enc.encrypt(dto.totpSecret) : null,
        staticIpPrimary: dto.staticIpPrimary ?? null,
        staticIpSecondary: dto.staticIpSecondary ?? null,
        enabled: dto.enabled ?? true,
      },
    });
    return this.redact(created);
  }

  private async findMaster(id: string) {
    const acc = await this.prisma.tradingAccount.findUnique({ where: { id } });
    if (!acc || acc.accountType !== AccountType.MASTER) {
      throw new NotFoundException('Master account not found');
    }
    return acc;
  }

  async get(id: string) {
    const acc = await this.findMaster(id);
    return this.redact(acc);
  }

  async update(id: string, dto: UpdateMasterAccountDto) {
    await this.findMaster(id);
    const data: Prisma.TradingAccountUpdateInput = {};
    if (dto.broker !== undefined) data.broker = dto.broker;
    if (dto.platform !== undefined) data.platform = dto.platform;
    if (dto.nickname !== undefined) data.nickname = dto.nickname;
    if (dto.clientId !== undefined) data.clientId = dto.clientId;
    if (dto.apiKey !== undefined) data.encryptedApiKey = dto.apiKey ? this.enc.encrypt(dto.apiKey) : null;
    if (dto.apiSecret !== undefined) data.encryptedApiSecret = dto.apiSecret ? this.enc.encrypt(dto.apiSecret) : null;
    if (dto.vendorCode !== undefined) data.encryptedVendorCode = dto.vendorCode ? this.enc.encrypt(dto.vendorCode) : null;
    if (dto.password !== undefined) data.encryptedPassword = dto.password ? this.enc.encrypt(dto.password) : null;
    if (dto.totpSecret !== undefined) data.encryptedTotpSecret = dto.totpSecret ? this.enc.encrypt(dto.totpSecret) : null;
    if (dto.staticIpPrimary !== undefined) data.staticIpPrimary = dto.staticIpPrimary || null;
    if (dto.staticIpSecondary !== undefined) data.staticIpSecondary = dto.staticIpSecondary || null;
    if (dto.enabled !== undefined) data.enabled = dto.enabled;
    const updated = await this.prisma.tradingAccount.update({ where: { id }, data });
    return this.redact(updated);
  }

  async remove(id: string) {
    await this.findMaster(id);
    await this.prisma.tradingAccount.delete({ where: { id } });
    return { ok: true };
  }

  async setEnabled(id: string, enabled: boolean) {
    await this.findMaster(id);
    const updated = await this.prisma.tradingAccount.update({ where: { id }, data: { enabled } });
    return this.redact(updated);
  }
}
