import { Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
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

/** Mask a secret for DEBUG logs — never log full tokens/secrets. */
function maskSecret(v?: string | null): string {
  if (!v) return 'none';
  const s = String(v);
  return s.length <= 6 ? '***' : `${s.slice(0, 3)}…${s.slice(-3)}`;
}

@Controller('brokers/fyers')
export class FyersController {
  private readonly adapter = new FyersAdapter();
  private readonly logger = new Logger('FyersController');

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

    // Sprint 6.2.13 (Fyers reconnect fix) — DEBUG trace of the persistence
    // handshake. Secrets are always masked.
    this.logger.debug(
      `[Fyers OAuth] callback started | broker=FYERS masterAccountId=${tradingAccountId}`,
    );

    try {
      const session = await this.adapter.exchangeToken(authCode);
      this.logger.debug(
        `[Fyers OAuth] token received | access_token=${maskSecret(
          session?.access_token,
        )} refresh_token=${maskSecret(session?.refresh_token)}`,
      );

      const profile = await this.adapter.getProfile();
      this.logger.debug(
        `[Fyers OAuth] profile resolved | userId=${profile?.userId ?? 'n/a'}`,
      );

      // 1) Persist credentials — completes BEFORE any redirect.
      this.logger.debug(
        `[Fyers OAuth] credential persistence started | masterAccountId=${tradingAccountId}`,
      );
      await this.fyersService.saveSession(tradingAccountId, session, profile);
      this.logger.debug(
        `[Fyers OAuth] credential persistence completed | masterAccountId=${tradingAccountId}`,
      );

      // 2) Validate persistence by reloading exactly as the adapter does.
      this.logger.debug(
        `[Fyers OAuth] credential validation started | masterAccountId=${tradingAccountId}`,
      );
      const validation =
        await this.fyersService.validatePersistedSession(tradingAccountId);
      if (!validation.ok) {
        this.logger.error(
          `[Fyers OAuth] credential validation FAILED | masterAccountId=${tradingAccountId} reason=${validation.reason}`,
        );
        return res.redirect(
          await buildBrokerCallbackRedirect(this.prisma, {
            tradingAccountId,
            returnTo,
            result: {
              ok: false,
              error: `Fyers reconnect failed: ${validation.reason}`,
            },
          }),
        );
      }
      this.logger.debug(
        `[Fyers OAuth] credentials successfully reloaded | masterAccountId=${tradingAccountId} userId=${validation.userId}`,
      );

      // 3) Only now is the reconnect a success.
      this.logger.debug(
        `[Fyers OAuth] redirect initiated (success) | masterAccountId=${tradingAccountId}`,
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
      this.logger.error(
        `[Fyers OAuth] callback failed | masterAccountId=${tradingAccountId} reason=${String(
          msg,
        )}`,
      );
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
