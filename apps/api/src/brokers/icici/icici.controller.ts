import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';
import { ICICIDirectAdapter } from './icici.adapter';
import { ICICIDirectService } from './icici.service';
import { buildBrokerCallbackRedirect } from '../broker-callback-redirect';
import { putOAuthState, takeOAuthState } from '../oauth-state.store';
import {
  OAUTH_STATE_COOKIE,
  clearOAuthStateCookie,
  readCookie,
  setOAuthStateCookie,
} from '../oauth-cookie';

/**
 * Sprint 6.2.0 — ICICI Direct (Breeze) OAuth-style login flow.
 *
 * Reuses the exact shared OAuth plumbing already used by Zerodha/Fyers
 * (server-side state store + HttpOnly state cookie + shared callback
 * redirect builder). Because Breeze's registered redirect URL may return the
 * API session token either as a query param (GET) or a form POST, both a GET
 * and a POST callback are wired to the same handler.
 *
 * Sprint 6.2.0 Hotfix — the routes are registered under BOTH `brokers/icici`
 * and `api/brokers/icici`. The NestJS API runs with an empty global prefix
 * (`setGlobalPrefix('')`), but the production ingress exposes the API under
 * `/api`. GET flows reached NestJS fine, but Breeze delivers this callback as
 * a cross-site POST to `/api/brokers/icici/callback` which NestJS had no route
 * for → "Cannot POST /api/brokers/icici/callback". Serving both prefixes makes
 * the callback resolve whether or not the `/api` segment is stripped upstream,
 * without touching the shared global prefix or any other broker.
 */
@Controller(['brokers/icici', 'api/brokers/icici'])
export class ICICIDirectController {
  constructor(
    private readonly iciciService: ICICIDirectService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  @Get('login')
  async login(
    @Query('tradingAccountId') tradingAccountId: string,
    @Query('returnTo') returnTo: string | undefined,
    @Res() res: Response,
  ) {
    const account = tradingAccountId
      ? await this.prisma.tradingAccount.findUnique({
          where: { id: tradingAccountId },
        })
      : null;

    if (!account || !account.encryptedApiKey) {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId,
          returnTo,
          result: {
            ok: false,
            error:
              'ICICI Direct API key is not configured for this account. Add the API Key and Secret first.',
          },
        }),
      );
    }

    const apiKey = this.encryption.decrypt(account.encryptedApiKey);
    const adapter = new ICICIDirectAdapter();
    adapter.setCredentials(apiKey, '');

    const stateId = randomUUID();
    putOAuthState(stateId, { tradingAccountId, returnTo });
    // Sprint 6.2.0 Hotfix — Breeze returns via a cross-site POST, on which a
    // SameSite=Lax cookie is NOT sent. Use SameSite=None (Secure) so the OAuth
    // state cookie survives the POST callback and state validation works.
    setOAuthStateCookie(res, stateId, 'None');
    return res.redirect(adapter.getLoginUrl());
  }

  @Get('callback')
  async callbackGet(
    @Query('apisession') apiSessionA: string | undefined,
    @Query('API_Session') apiSessionB: string | undefined,
    @Query('session_token') apiSessionC: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const token = apiSessionA ?? apiSessionB ?? apiSessionC;
    return this.handleCallback(token, req, res);
  }

  @Post('callback')
  async callbackPost(
    @Body() body: any,
    @Query() query: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const token =
      body?.apisession ??
      body?.API_Session ??
      body?.session_token ??
      query?.apisession ??
      query?.API_Session ??
      query?.session_token;
    return this.handleCallback(token, req, res);
  }

  private async handleCallback(
    sessionToken: string | undefined,
    req: Request,
    res: Response,
  ) {
    const stateId = readCookie(req, OAUTH_STATE_COOKIE);
    const entry = takeOAuthState(stateId);
    clearOAuthStateCookie(res, 'None');

    const tradingAccountId = entry?.tradingAccountId;
    const returnTo = entry?.returnTo;

    if (!sessionToken) {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId,
          returnTo,
          result: { ok: false, error: 'Missing session token from broker' },
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
      const account = await this.prisma.tradingAccount.findUnique({
        where: { id: tradingAccountId },
      });
      if (!account || !account.encryptedApiKey || !account.encryptedApiSecret) {
        throw new Error('ICICI Direct API key/secret is not configured.');
      }

      const apiKey = this.encryption.decrypt(account.encryptedApiKey);
      const apiSecret = this.encryption.decrypt(account.encryptedApiSecret);

      const adapter = new ICICIDirectAdapter();
      adapter.setCredentials(apiKey, apiSecret);

      const session = await adapter.exchangeToken(sessionToken);
      const profile = await adapter.getProfile();

      await this.iciciService.saveSession(tradingAccountId, session, profile);

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
