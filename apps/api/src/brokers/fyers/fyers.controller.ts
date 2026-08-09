import { Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { TradingAccount } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';
import { FyersAdapter } from './fyers.adapter';
import { FyersService } from './fyers.service';
import { buildBrokerCallbackRedirect } from '../broker-callback-redirect';
import { putOAuthState, takeOAuthState, encodeOAuthState, decodeOAuthState } from '../oauth-state.store';
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

@Controller(['brokers/fyers', 'api/brokers/fyers'])
export class FyersController {
  private readonly logger = new Logger('FyersController');

  constructor(
    private readonly fyersService: FyersService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Sprint 6.2.15 — account isolation. Build a Fyers adapter bound to THIS
   * account's own App ID (api key) + Secret ID (api secret), mirroring the
   * ICICIDirectController pattern (decrypt encryptedApiKey/encryptedApiSecret →
   * adapter.setCredentials). A per-request adapter (never a controller-shared
   * singleton keyed off env) is what keeps two Fyers accounts from crossing
   * over onto the env App ID's profile.
   */
  private buildAccountAdapter(account: TradingAccount): FyersAdapter {
    const adapter = new FyersAdapter();
    const appId = this.encryption.decrypt(account.encryptedApiKey!);
    const secretId = this.encryption.decrypt(account.encryptedApiSecret!);
    adapter.setCredentials(appId, secretId);
    return adapter;
  }

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

    if (!account) {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId,
          returnTo,
          result: { ok: false, error: 'Trading account not found.' },
        }),
      );
    }
    if (!account.encryptedApiKey || !account.encryptedApiSecret) {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId,
          returnTo,
          result: {
            ok: false,
            error:
              'Save the Fyers API Key (App ID) and API Secret on this account before connecting.',
          },
        }),
      );
    }

    // Per-account adapter → the OAuth login URL carries THIS account's App ID.
    const adapter = this.buildAccountAdapter(account);
    // Sprint 6.2.17 — carry the reconnect context in the OAuth `state` param
    // (echoed back by Fyers on the callback), so it no longer depends on the
    // in-memory map surviving. The cookie/map are still written as a
    // backward-compatible fallback.
    const stateToken = encodeOAuthState({ tradingAccountId, returnTo });
    const stateId = randomUUID();
    putOAuthState(stateId, { tradingAccountId, returnTo });
    setOAuthStateCookie(res, stateId);
    return res.redirect(adapter.getLoginUrl(stateToken));
  }

  @Get('callback')
  async callback(
    @Query('auth_code') authCode: string,
    @Query('s') statusParam: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
    @Query('state') stateParam?: string,
  ) {
    // Sprint 6.2.17 — recover the reconnect context PRIMARILY from the OAuth
    // `state` param echoed back by Fyers (self-contained; survives hot reloads,
    // multiple API instances and redirects with no server-side memory). The
    // in-memory cookie/map is only a backward-compatible fallback.
    const stateEntry = decodeOAuthState(stateParam);
    const stateId = readCookie(req, OAUTH_STATE_COOKIE);
    const cookieEntry = takeOAuthState(stateId);
    clearOAuthStateCookie(res);

    const tradingAccountId =
      stateEntry?.tradingAccountId ?? cookieEntry?.tradingAccountId;
    const returnTo = stateEntry?.returnTo ?? cookieEntry?.returnTo;

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
      // Sprint 6.2.15 — resolve THIS account's own credentials before the token
      // exchange. generate_access_token + the authenticated read header both
      // use the account's App ID, so a per-account adapter is mandatory here —
      // never the env App ID (which would authenticate the wrong Fyers user).
      const account = await this.prisma.tradingAccount.findUnique({
        where: { id: tradingAccountId },
      });
      if (!account) {
        return res.redirect(
          await buildBrokerCallbackRedirect(this.prisma, {
            tradingAccountId,
            returnTo,
            result: { ok: false, error: 'Trading account not found.' },
          }),
        );
      }
      if (!account.encryptedApiKey || !account.encryptedApiSecret) {
        return res.redirect(
          await buildBrokerCallbackRedirect(this.prisma, {
            tradingAccountId,
            returnTo,
            result: {
              ok: false,
              error:
                'Save the Fyers API Key (App ID) and API Secret on this account before connecting.',
            },
          }),
        );
      }
      const adapter = this.buildAccountAdapter(account);

      const session = await adapter.exchangeToken(authCode);
      this.logger.debug(
        `[Fyers OAuth] token received | access_token=${maskSecret(
          session?.access_token,
        )} refresh_token=${maskSecret(session?.refresh_token)}`,
      );

      const profile = await adapter.getProfile();
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
        // Safeguard: a failed reconnect must NOT leave the account looking
        // CONNECTED. Force it back to DISCONNECTED so the UI/session-health
        // prompts a fresh reconnect instead of surfacing a stale/corrupt session.
        await this.prisma.tradingAccount
          .update({
            where: { id: tradingAccountId },
            data: { connectionStatus: 'DISCONNECTED', lastHeartbeat: null },
          })
          .catch(() => undefined);
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
