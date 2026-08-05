import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../prisma/prisma.module';
import { FyersAdapter } from './fyers.adapter';
import { FyersService } from './fyers.service';
import { buildBrokerCallbackRedirect } from '../broker-callback-redirect';
import { putOAuthState, takeOAuthState } from '../oauth-state.store';
import {
  OAUTH_STATE_COOKIE,
  clearOAuthStateCookie,
  readCookie,
  setOAuthStateCookie,
} from '../oauth-cookie';

@Controller('brokers/fyers')
export class FyersController {
  private readonly adapter = new FyersAdapter();

  constructor(
    private readonly fyersService: FyersService,
    private readonly prisma: PrismaService,
  ) {}

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
    @Query('auth_code') authCode: string,
    @Query('s') statusParam: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const stateId = readCookie(req, OAUTH_STATE_COOKIE);
    const entry = takeOAuthState(stateId);
    clearOAuthStateCookie(res);

    const tradingAccountId = entry?.tradingAccountId;
    const returnTo = entry?.returnTo;

    if (statusParam && statusParam !== 'ok') {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId,
          returnTo,
          result: { ok: false, error: `Broker login ${statusParam}` },
        }),
      );
    }

    if (!authCode) {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId,
          returnTo,
          result: { ok: false, error: 'Missing auth code from broker' },
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
      const session = await this.adapter.exchangeToken(authCode);
      const profile = await this.adapter.getProfile();

      await this.fyersService.saveSession(tradingAccountId, session, profile);

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
