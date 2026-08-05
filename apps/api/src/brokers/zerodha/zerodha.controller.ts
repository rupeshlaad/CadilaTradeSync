import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../prisma/prisma.module';
import { ZerodhaAdapter } from './zerodha.adapter';
import { ZerodhaService } from './zerodha.service';
import { buildBrokerCallbackRedirect } from '../broker-callback-redirect';
import { putOAuthState, takeOAuthState } from '../oauth-state.store';
import {
  OAUTH_STATE_COOKIE,
  clearOAuthStateCookie,
  readCookie,
  setOAuthStateCookie,
} from '../oauth-cookie';

@Controller('brokers/zerodha')
export class ZerodhaController {
  private readonly adapter = new ZerodhaAdapter();

  constructor(
    private readonly zerodhaService: ZerodhaService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Sprint 6.1.1 — Broker login initiator.
   *
   *   /brokers/zerodha/login?tradingAccountId=<id>&returnTo=<url>
   *
   * A random state id is stored server-side (with the trading
   * account id and originating page URL) and shipped to the browser
   * as an HttpOnly cookie so the /callback handler can resolve the
   * flow without relying on a global slot. `returnTo` is validated
   * for open-redirect safety by `buildBrokerCallbackRedirect`.
   */
  @Get('login')
  login(
    @Query('tradingAccountId') tradingAccountId: string,
    @Query('returnTo') returnTo: string | undefined,
    @Res() res: Response,
  ) {
    const stateId = randomUUID();
    putOAuthState(stateId, { tradingAccountId, returnTo });
    setOAuthStateCookie(res, stateId);
    return res.redirect(this.adapter.getLoginUrl());
  }

  @Get('callback')
  async callback(
    @Query('request_token') requestToken: string,
    @Query('status') status: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const stateId = readCookie(req, OAUTH_STATE_COOKIE);
    const entry = takeOAuthState(stateId);
    clearOAuthStateCookie(res);

    const tradingAccountId = entry?.tradingAccountId;
    const returnTo = entry?.returnTo;

    if (status && status !== 'success') {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId,
          returnTo,
          result: { ok: false, error: `Broker login ${status}` },
        }),
      );
    }

    if (!requestToken) {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId,
          returnTo,
          result: { ok: false, error: 'Missing request token from broker' },
        }),
      );
    }

    if (!tradingAccountId) {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId: undefined,
          returnTo,
          result: {
            ok: false,
            error: 'Reconnect context missing. Please retry from the account.',
          },
        }),
      );
    }

    try {
      const session = await this.adapter.exchangeToken(requestToken);
      const profile = await this.adapter.getProfile();

      await this.zerodhaService.saveSession(
        tradingAccountId,
        session,
        profile,
      );

      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId,
          returnTo,
          result: { ok: true },
        }),
      );
    } catch (err: any) {
      const msg =
        (err && (err.message || err.error_type)) ||
        'Broker authentication failed';
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId,
          returnTo,
          result: { ok: false, error: String(msg) },
        }),
      );
    }
  }
}
