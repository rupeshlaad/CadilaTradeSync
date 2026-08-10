import { Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { TradingAccount } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';
import { UpstoxAdapter } from './upstox.adapter';
import { UpstoxService } from './upstox.service';
import { buildBrokerCallbackRedirect } from '../broker-callback-redirect';
import {
  putOAuthState,
  takeOAuthState,
  encodeOAuthState,
  decodeOAuthState,
} from '../oauth-state.store';
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

/**
 * Sprint 6.3 — Upstox OAuth 2.0 controller.
 *
 * Mirrors the Fyers controller exactly (per-account credential isolation,
 * self-contained OAuth `state` reconnect context, post-persist validation
 * gate) and registers BOTH the bare and `/api`-prefixed routes so the
 * broker-configured redirect URI works whether or not a global `/api` prefix
 * is present (same dual-prefix pattern as ICICI + Fyers 6.2.16).
 */
@Controller(['brokers/upstox', 'api/brokers/upstox'])
export class UpstoxController {
  private readonly logger = new Logger('UpstoxController');

  constructor(
    private readonly upstoxService: UpstoxService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Build an Upstox adapter bound to THIS account's own client_id (api key) +
   * client_secret (api secret) + the platform redirect URI. A per-request
   * adapter (never a controller-shared singleton keyed off env) keeps two
   * Upstox accounts from crossing over.
   */
  private buildAccountAdapter(account: TradingAccount): UpstoxAdapter {
    const adapter = new UpstoxAdapter();
    const apiKey = this.encryption.decrypt(account.encryptedApiKey!);
    const apiSecret = this.encryption.decrypt(account.encryptedApiSecret!);
    adapter.setCredentials(apiKey, apiSecret);
    if (process.env.UPSTOX_REDIRECT_URI) {
      adapter.setRedirectUri(process.env.UPSTOX_REDIRECT_URI);
    }
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
              'Save the Upstox API Key and API Secret on this account before connecting.',
          },
        }),
      );
    }

    const adapter = this.buildAccountAdapter(account);
    // Carry the reconnect context in the OAuth `state` param (echoed back by
    // Upstox on the callback) so it survives hot reloads / multiple instances
    // with no server-side memory. Cookie/map retained as a fallback.
    const stateToken = encodeOAuthState({ tradingAccountId, returnTo });
    const stateId = randomUUID();
    putOAuthState(stateId, { tradingAccountId, returnTo });
    setOAuthStateCookie(res, stateId);
    return res.redirect(adapter.getLoginUrl(stateToken));
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('error') errorParam: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
    @Query('state') stateParam?: string,
  ) {
    const stateEntry = decodeOAuthState(stateParam);
    const stateId = readCookie(req, OAUTH_STATE_COOKIE);
    const cookieEntry = takeOAuthState(stateId);
    clearOAuthStateCookie(res);

    const tradingAccountId =
      stateEntry?.tradingAccountId ?? cookieEntry?.tradingAccountId;
    const returnTo = stateEntry?.returnTo ?? cookieEntry?.returnTo;

    if (errorParam) {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId,
          returnTo,
          result: { ok: false, error: `Broker login failed: ${errorParam}` },
        }),
      );
    }

    if (!code) {
      return res.redirect(
        await buildBrokerCallbackRedirect(this.prisma, {
          tradingAccountId,
          returnTo,
          result: { ok: false, error: 'Missing authorization code from broker' },
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

    this.logger.debug(
      `[Upstox OAuth] callback started | broker=UPSTOX masterAccountId=${tradingAccountId}`,
    );

    try {
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
                'Save the Upstox API Key and API Secret on this account before connecting.',
            },
          }),
        );
      }
      const adapter = this.buildAccountAdapter(account);

      const session = await adapter.exchangeToken(code);
      this.logger.debug(
        `[Upstox OAuth] token received | access_token=${maskSecret(
          session?.access_token,
        )}`,
      );

      const profile = await adapter.getProfile();
      this.logger.debug(
        `[Upstox OAuth] profile resolved | userId=${profile?.userId ?? 'n/a'}`,
      );

      await this.upstoxService.saveSession(tradingAccountId, session, profile);

      const validation =
        await this.upstoxService.validatePersistedSession(tradingAccountId);
      if (!validation.ok) {
        this.logger.error(
          `[Upstox OAuth] credential validation FAILED | masterAccountId=${tradingAccountId} reason=${validation.reason}`,
        );
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
              error: `Upstox connect failed: ${validation.reason}`,
            },
          }),
        );
      }

      this.logger.debug(
        `[Upstox OAuth] redirect initiated (success) | masterAccountId=${tradingAccountId} userId=${validation.userId}`,
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
        `[Upstox OAuth] callback failed | masterAccountId=${tradingAccountId} reason=${String(
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
