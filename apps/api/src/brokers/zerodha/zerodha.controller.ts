import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.module';
import { ZerodhaAdapter } from './zerodha.adapter';
import { ZerodhaService } from './zerodha.service';
import { buildBrokerCallbackRedirect } from '../broker-callback-redirect';

const loginStore = new Map<string, string>();

@Controller('brokers/zerodha')
export class ZerodhaController {
  private readonly adapter = new ZerodhaAdapter();

  constructor(
    private readonly zerodhaService: ZerodhaService,
    // Sprint 6.1 — Prisma is required to route the OAuth redirect to
    // the correct portal (Master → Admin app, Follower → Web app).
    private readonly prisma: PrismaService,
  ) {}

  @Get('login')
  login(
    @Query('tradingAccountId') tradingAccountId: string,
    @Res() res: Response,
  ) {
    // Preserve reconnect context via the existing in-memory store mechanism.
    loginStore.set('current', tradingAccountId);

    return res.redirect(this.adapter.getLoginUrl());
  }

  @Get('callback')
  async callback(
    @Query('request_token') requestToken: string,
    @Query('status') status: string | undefined,
    @Res() res: Response,
  ) {
    const tradingAccountId = loginStore.get('current');

    // Zerodha OAuth sometimes signals user-side failure via `status` param.
    if (status && status !== 'success') {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, tradingAccountId, {
          ok: false,
          error: `Broker login ${status}`,
        }),
      );
    }

    if (!requestToken) {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, tradingAccountId, {
          ok: false,
          error: 'Missing request token from broker',
        }),
      );
    }

    try {
      const session = await this.adapter.exchangeToken(requestToken);
      const profile = await this.adapter.getProfile();

      if (!tradingAccountId) {
        // Session was created upstream but we lost the reconnect context —
        // still land the user in an app, never on a raw JSON page.
        return res.redirect(
          await buildBrokerCallbackRedirect(this.prisma, undefined, {
            ok: false,
            error: 'Reconnect context missing. Please retry from the account.',
          }),
        );
      }

      loginStore.delete('current');

      await this.zerodhaService.saveSession(
        tradingAccountId,
        session,
        profile,
      );

      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, tradingAccountId, {
          ok: true,
        }),
      );
    } catch (err: any) {
      const msg =
        (err && (err.message || err.error_type)) || 'Broker authentication failed';
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, tradingAccountId, {
          ok: false,
          error: String(msg),
        }),
      );
    }
  }
}
