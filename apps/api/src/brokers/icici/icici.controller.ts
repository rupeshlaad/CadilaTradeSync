import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';
import { ICICIDirectAdapter } from './icici.adapter';
import { ICICIDirectService } from './icici.service';

/**
 * Sprint 6.2.1 — ICICI Direct manual API-Session authentication.
 *
 * Breeze has no reliable server-to-server OAuth callback (the interactive
 * login returns via a cross-site POST that browsers routinely strip the state
 * cookie from). The OAuth login/callback flow is therefore removed for ICICI
 * and replaced with a single authenticated endpoint: the user pastes a fresh
 * API Session generated from the ICICI Breeze Portal, and CTS exchanges it via
 * the official `customerdetails` call to establish the BrokerSession. All
 * other brokers (Zerodha/Fyers/Shoonya) and the shared OAuth infrastructure
 * are untouched.
 */
@Controller(['brokers/icici', 'api/brokers/icici'])
@UseGuards(JwtAuthGuard)
export class ICICIDirectController {
  constructor(
    private readonly iciciService: ICICIDirectService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  @Post('connect-session')
  async connectSession(
    @Req() req: any,
    @Body() body: { tradingAccountId?: string; apiSession?: string },
  ) {
    const tradingAccountId = body?.tradingAccountId?.trim();
    const apiSession = body?.apiSession?.trim();

    if (!tradingAccountId) {
      throw new BadRequestException('tradingAccountId is required.');
    }
    if (!apiSession) {
      throw new BadRequestException('API Session is required.');
    }

    // 1) Load the owned TradingAccount.
    const account = await this.prisma.tradingAccount.findFirst({
      where: { id: tradingAccountId, userId: req.user.sub },
    });
    if (!account) {
      throw new BadRequestException('Trading account not found.');
    }
    if (account.broker !== 'ICICI_DIRECT') {
      throw new BadRequestException(
        'This endpoint supports ICICI Direct accounts only.',
      );
    }

    // 2) Load encrypted API Key + API Secret (Client ID stays as-is).
    if (!account.encryptedApiKey || !account.encryptedApiSecret) {
      throw new BadRequestException(
        'Save the ICICI Direct API Key and API Secret on this account before connecting.',
      );
    }
    const apiKey = this.encryption.decrypt(account.encryptedApiKey);
    const apiSecret = this.encryption.decrypt(account.encryptedApiSecret);

    // 3) Validate the API Session via the official Breeze customerdetails call.
    const adapter = new ICICIDirectAdapter();
    adapter.setCredentials(apiKey, apiSecret);

    let session: any;
    let profile: any;
    try {
      session = await adapter.exchangeToken(apiSession);
      profile = await adapter.getProfile();
    } catch (err: any) {
      const msg =
        (err && (err.message || err.error_type)) ||
        'Invalid API Session or credentials.';
      // 4) Invalid → proper error.
      throw new BadRequestException(
        `ICICI Direct authentication failed: ${String(msg)}`,
      );
    }

    if (!profile || !profile.userId) {
      throw new BadRequestException(
        'ICICI Direct did not return a valid customer profile. Please generate a fresh API Session from the Breeze Portal and try again.',
      );
    }

    // 5) + 6) Persist BrokerSession and mark the TradingAccount CONNECTED.
    await this.iciciService.saveSession(tradingAccountId, session, profile);

    // 7) Return the broker profile.
    return { ok: true, profile };
  }
}
