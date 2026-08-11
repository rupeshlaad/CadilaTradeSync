import { Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { TradingAccount } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';
import { ShoonyaAdapter } from './shoonya.adapter';
import { ShoonyaService } from './shoonya.service';
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
 * Sprint 6.2.0 — Shoonya (Finvasia Noren) OAuth 2.0 controller.
 *
 * Replaces the retired QuickAuth server-side login with the official OAuth
 * authorization-code flow, mirroring the Fyers/Upstox controllers exactly:
 * per-account credential isolation, self-contained OAuth `state` reconnect
 * context (with the cookie/map fallback), and a post-persist validation gate
 * so a failed connect never redirects as success. Registers BOTH the bare and
 * `/api`-prefixed routes (same dual-prefix pattern as Fyers 6.2.16 / Upstox)
 * so the broker-configured redirect URI works with or without a global `/api`
 * prefix.
 */
@Controller(['brokers/shoonya', 'api/brokers/shoonya'])
export class ShoonyaController {
  private readonly logger = new Logger('ShoonyaController');

  constructor(
    private readonly shoonyaService: ShoonyaService,
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Build a Shoonya adapter bound to THIS account's own OAuth API key
   * (client_id) + secret code. A per-request adapter (never a controller-shared
   * singleton) keeps two Shoonya accounts from crossing over on the authorize
   * URL / token-exchange checksum.
   */
  private buildAccountAdapter(account: TradingAccount): ShoonyaAdapter {
    const adapter = new ShoonyaAdapter();
    const apiKey = this.encryption.decrypt(account.encryptedApiKey!);
    const secretCode = this.encryption.decrypt(account.encryptedApiSecret!);
    adapter.setCredentials(apiKey, secretCode);
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
              'Save the Shoonya OAuth API Key and Secret Code on this account before connecting.',
          },
        }),
      );
    }

    // Per-account adapter → the authorize URL carries THIS account's API key.
    const adapter = this.buildAccountAdapter(account);
    // Carry the reconnect context in the OAuth `state` param (echoed back by
    // the broker on the callback when supported) so it survives hot reloads /
    // multiple instances with no server-side memory. Cookie/map retained as a
    // backward-compatible fallback (Shoonya may not echo `state`).
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
    // Recover the reconnect context PRIMARILY from the OAuth `state` param
    // echoed back by the broker; fall back to the in-memory cookie/map.
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
      `[Shoonya OAuth] callback started | broker=SHOONYA masterAccountId=${tradingAccountId}`,
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
                'Save the Shoonya OAuth API Key and Secret Code on this account before connecting.',
            },
          }),
        );
      }
      const adapter = this.buildAccountAdapter(account);

      const session = await adapter.exchangeToken(code);
      this.logger.debug(
        `[Shoonya OAuth] token received | access_token=${maskSecret(
          session?.access_token,
        )} refresh_token=${maskSecret(session?.refresh_token)}`,
      );

      const profile = await adapter.getProfile();
      this.logger.debug(
        `[Shoonya OAuth] profile resolved | userId=${profile?.userId ?? 'n/a'}`,
      );

      // 1) Persist credentials — completes BEFORE any redirect.
      await this.shoonyaService.saveSession(tradingAccountId, session, profile);

      // 2) Validate persistence by reloading exactly as the adapter factory does.
      const validation =
        await this.shoonyaService.validatePersistedSession(tradingAccountId);
      if (!validation.ok) {
        this.logger.error(
          `[Shoonya OAuth] credential validation FAILED | masterAccountId=${tradingAccountId} reason=${validation.reason}`,
        );
        // A failed connect must NOT leave the account looking CONNECTED.
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
              error: `Shoonya connect failed: ${validation.reason}`,
            },
          }),
        );
      }

      this.logger.debug(
        `[Shoonya OAuth] redirect initiated (success) | masterAccountId=${tradingAccountId} userId=${validation.userId}`,
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
        `[Shoonya OAuth] callback failed | masterAccountId=${tradingAccountId} reason=${String(
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
