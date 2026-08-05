import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { PrismaService } from '../../prisma/prisma.module';
import { FyersAdapter } from './fyers.adapter';
import { FyersService } from './fyers.service';
import { buildBrokerCallbackRedirect } from '../broker-callback-redirect';

const loginStore = new Map<string, string>();

@Controller('brokers/fyers')
export class FyersController {
  private readonly adapter = new FyersAdapter();

  constructor(
    private readonly fyersService: FyersService,
    // Sprint 6.1 — Prisma is required to route the OAuth redirect to
    // the correct portal after successful authentication.
    private readonly prisma: PrismaService,
  ) {}

  @Get('login')
  login(
    @Query('tradingAccountId') tradingAccountId: string,
    @Res() res: Response,
  ) {
    loginStore.set('current', tradingAccountId);

    return res.redirect(this.adapter.getLoginUrl());
  }

  @Get('callback')
  async callback(
    @Query('auth_code') authCode: string,
    @Query('s') statusParam: string | undefined,
    @Res() res: Response,
  ) {
    const tradingAccountId = loginStore.get('current');

    if (statusParam && statusParam !== 'ok') {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, tradingAccountId, {
          ok: false,
          error: `Broker login ${statusParam}`,
        }),
      );
    }

    if (!authCode) {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, tradingAccountId, {
          ok: false,
          error: 'Missing auth code from broker',
        }),
      );
    }

    try {
      const session = await this.adapter.exchangeToken(authCode);
      const profile = await this.adapter.getProfile();

      if (!tradingAccountId) {
        return res.redirect(
          await buildBrokerCallbackRedirect(this.prisma, undefined, {
            ok: false,
            error: 'Reconnect context missing. Please retry from the account.',
          }),
        );
      }

      loginStore.delete('current');

      await this.fyersService.saveSession(tradingAccountId, session, profile);

      // Sprint 6.1 — replace the previous raw JSON response with a
      // redirect back to the correct portal so the user never lands
      // on the broker's callback URL.
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, tradingAccountId, {
          ok: true,
        }),
      );
    } catch (err: any) {
      const msg =
        (err && (err.message || err.error_type)) ||
        'Broker authentication failed';
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, tradingAccountId, {
          ok: false,
          error: String(msg),
        }),
      );
    }
  }
}
