import {
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';

import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';
import { ICICIDirectAdapter } from './icici.adapter';
import { ICICIDirectService } from './icici.service';
import {
  ICICIOAuthState,
  buildICICIRedirect,
  clearICICIStateCookie,
  encodeICICIState,
  readICICIStateCookie,
  resolvePortal,
  setICICIStateCookie,
} from './icici-oauth-state';

/**
 * Sprint 6.2.0 — ICICI Direct (Breeze) OAuth-style login flow.
 *
 * Sprint 6.2.0 Hotfix   — routes served under both `brokers/icici` and
 *   `api/brokers/icici` (empty NestJS global prefix vs the `/api` ingress),
 *   for GET + POST (Breeze returns via a cross-site POST).
 * Sprint 6.2.0 Hotfix-2 — the full OAuth context (tradingAccountId, userId,
 *   broker, originating portal, returnTo, reconnect mode, state id) is carried
 *   inside a single HMAC-signed cookie so it survives restarts/replicas and
 *   the cross-site POST. The callback rebuilds the redirect from ONLY the
 *   stored portal + returnTo, so a login started on the Follower portal always
 *   returns to /dashboard/broker-accounts and one started on the Master portal
 *   always returns to /dashboard/master-accounts — it never infers the portal
 *   and never defaults to Master.
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
    @Query('portal') portalParam: string | undefined,
    @Res() res: Response,
  ) {
    const portal = resolvePortal(portalParam, returnTo);

    const account = tradingAccountId
      ? await this.prisma.tradingAccount.findUnique({
          where: { id: tradingAccountId },
        })
      : null;

    if (!account || !account.encryptedApiKey) {
      const state: ICICIOAuthState | null = tradingAccountId
        ? {
            stateId: randomUUID(),
            tradingAccountId,
            userId: account?.clientId ?? '',
            broker: 'ICICI_DIRECT',
            portal,
            returnTo,
            reconnectMode: true,
          }
        : null;
      return res.redirect(
        buildICICIRedirect({
          state,
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

    const state: ICICIOAuthState = {
      stateId: randomUUID(),
      tradingAccountId,
      userId: account.clientId ?? '',
      broker: 'ICICI_DIRECT',
      portal,
      returnTo,
      reconnectMode: true,
    };
    setICICIStateCookie(res, encodeICICIState(state));

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
    const state = readICICIStateCookie(req);
    clearICICIStateCookie(res);

    if (!sessionToken) {
      return res.redirect(
        buildICICIRedirect({
          state,
          result: { ok: false, error: 'Missing session token from broker' },
        }),
      );
    }

    if (!state || !state.tradingAccountId) {
      return res.redirect(
        buildICICIRedirect({
          state,
          result: {
            ok: false,
            error: 'Reconnect context missing. Please retry from the account.',
          },
        }),
      );
    }

    try {
      const account = await this.prisma.tradingAccount.findUnique({
        where: { id: state.tradingAccountId },
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

      await this.iciciService.saveSession(state.tradingAccountId, session, profile);

      return res.redirect(buildICICIRedirect({ state, result: { ok: true } }));
    } catch (err: any) {
      const msg =
        (err && (err.message || err.error_type)) ||
        'Broker authentication failed';
      return res.redirect(
        buildICICIRedirect({ state, result: { ok: false, error: String(msg) } }),
      );
    }
  }
}
