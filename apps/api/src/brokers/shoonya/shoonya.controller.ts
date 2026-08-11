import { Controller, Get, Logger, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { TradingAccount } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';
import { ShoonyaAdapter } from './shoonya.adapter';
import { ShoonyaService } from './shoonya.service';
import { buildBrokerCallbackRedirect } from '../broker-callback-redirect';
import { encodeOAuthState, decodeOAuthState } from '../oauth-state.store';
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
 * TEMPORARY DIAGNOSTICS (Shoonya OAuth context-loss investigation).
 * Parse a raw `Set-Cookie` string into its parts for logging ONLY. Does not
 * alter any cookie or behaviour.
 */
function describeSetCookie(raw: string): {
  written: boolean;
  name: string;
  value: string;
  path?: string;
  sameSite?: string;
  secure: boolean;
  maxAge?: string;
  domain?: string;
} {
  const parts = raw.split(';').map((p) => p.trim()).filter(Boolean);
  const [nameValue = ''] = parts;
  const eq = nameValue.indexOf('=');
  const name = eq >= 0 ? nameValue.slice(0, eq) : nameValue;
  const value = eq >= 0 ? nameValue.slice(eq + 1) : '';
  const attr = (k: string) =>
    parts
      .slice(1)
      .find((p) => p.toLowerCase().startsWith(`${k.toLowerCase()}=`))
      ?.split('=')
      .slice(1)
      .join('=');
  return {
    written: raw.length > 0,
    name,
    value,
    path: attr('Path'),
    sameSite: attr('SameSite'),
    secure: parts.slice(1).some((p) => p.toLowerCase() === 'secure'),
    maxAge: attr('Max-Age'),
    domain: attr('Domain'),
  };
}

/**
 * Sprint 6.2.0 — Shoonya (Finvasia Noren) OAuth 2.0 controller.
 *
 * Replaces the retired QuickAuth server-side login with the official OAuth
 * authorization-code flow, mirroring the Fyers/Upstox controllers: per-account
 * credential isolation and a post-persist validation gate so a failed connect
 * never redirects as success. Registers BOTH the bare and `/api`-prefixed
 * routes (same dual-prefix pattern as Fyers 6.2.16 / Upstox) so the
 * broker-configured redirect URI works with or without a global `/api` prefix.
 *
 * Reconnect-context recovery (fix): unlike Fyers/Upstox, Shoonya does NOT echo
 * the OAuth `state` param back on the callback (its authorize endpoint takes
 * only `client_id`; the redirect returns just `?code=`). Relying on `state`
 * (or on the in-memory state map behind a random cookie id, which is not shared
 * across API instances / restarts) therefore lost the context and produced
 * "Reconnect context missing". The context is now carried in a SELF-CONTAINED
 * cookie (the encoded state token itself), so the callback recovers it from the
 * `state` param when present, else from the cookie — with no dependency on the
 * broker echoing `state` or on any single instance's memory. Both the User
 * Portal and Master Account flows use this identical, durable path.
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

    // Per-account adapter → the authorize URL carries THIS account's client_id.
    const adapter = this.buildAccountAdapter(account);
    // Carry the reconnect context in a SELF-CONTAINED cookie (the encoded state
    // token itself). Shoonya does not echo `state`, so the callback recovers the
    // context from this cookie; storing the token — rather than a random id that
    // points at per-instance server memory — makes it survive hot reloads,
    // multiple API instances and the cross-site broker redirect. The same token
    // is also passed as `state` for brokers/setups that do echo it back.
    const stateToken = encodeOAuthState({ tradingAccountId, returnTo });
    setOAuthStateCookie(res, stateToken);
    const redirectUrl = adapter.getLoginUrl(stateToken);

    // TEMPORARY DIAGNOSTICS — read back exactly what Set-Cookie wrote (no change).
    const rawSetCookie = res.getHeader('Set-Cookie');
    const setCookieStr = Array.isArray(rawSetCookie)
      ? rawSetCookie.join('; ')
      : String(rawSetCookie ?? '');
    const ck = describeSetCookie(setCookieStr);
    this.logger.log(
      '\n========== SHOONYA LOGIN ==========\n' +
        `timestamp            : ${new Date().toISOString()}\n` +
        `TradingAccountId     : ${tradingAccountId ?? '(undefined)'}\n` +
        `ReturnTo             : ${returnTo ?? '(undefined)'}\n` +
        `Encoded State Token  : ${stateToken}\n` +
        `Encoded Token Length : ${stateToken.length}\n` +
        `Cookie Name          : ${ck.name}\n` +
        `Cookie Value         : ${ck.value}\n` +
        `Cookie Length        : ${ck.value.length}\n` +
        `Cookie Domain        : ${ck.domain ?? '(host-only / not set)'}\n` +
        `Cookie Path          : ${ck.path ?? '(none)'}\n` +
        `Cookie SameSite      : ${ck.sameSite ?? '(none)'}\n` +
        `Cookie Secure        : ${ck.secure}\n` +
        `Cookie Max-Age       : ${ck.maxAge ?? '(none)'}\n` +
        `Set-Cookie written?  : ${ck.written}\n` +
        `Redirect URL         : ${redirectUrl}\n` +
        '==================================',
    );
    return res.redirect(redirectUrl);
  }

  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('error') errorParam: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
    @Query('state') stateParam?: string,
  ) {
    // TEMPORARY DIAGNOSTICS — compute the individual inputs for logging ONLY.
    // These are pure reads; the recovery expression below is left UNCHANGED.
    const rawCookieHeader = req.headers?.cookie ?? '';
    const cookieVal = readCookie(req, OAUTH_STATE_COOKIE);
    const decodedFromState = decodeOAuthState(stateParam);
    const decodedFromCookie = decodeOAuthState(cookieVal);
    this.logger.log(
      '\n========== SHOONYA CALLBACK ==========\n' +
        `timestamp            : ${new Date().toISOString()}\n` +
        `Full URL             : ${req.originalUrl ?? req.url ?? '(none)'}\n` +
        `Host                 : ${req.headers?.host ?? '(none)'}\n` +
        `Origin               : ${req.headers?.origin ?? '(none)'}\n` +
        `Referer              : ${req.headers?.referer ?? '(none)'}\n` +
        `Query.code           : ${code ? maskSecret(code) : '(none)'}\n` +
        `Query.state          : ${stateParam ?? '(none)'}\n` +
        `Query.error          : ${errorParam ?? '(none)'}\n` +
        `Cookie Header (raw)  : ${rawCookieHeader || '(none)'}\n` +
        `Cookie[${OAUTH_STATE_COOKIE}] : ${cookieVal ?? '(none)'}\n` +
        `Decoded Cookie Value : ${JSON.stringify(decodedFromCookie ?? null)}\n` +
        `Decoded Cookie OK?   : ${!!decodedFromCookie}\n` +
        `Decoded State OK?    : ${!!decodedFromState}\n` +
        '====================================',
    );

    // Recover the reconnect context from the OAuth `state` param when the broker
    // echoes it, else from the SELF-CONTAINED state cookie set at /login. Both
    // decode the same token, so recovery no longer depends on Shoonya echoing
    // `state` or on any single API instance's in-memory map.
    const stateEntry =
      decodeOAuthState(stateParam) ??
      decodeOAuthState(readCookie(req, OAUTH_STATE_COOKIE));
    clearOAuthStateCookie(res);

    const tradingAccountId = stateEntry?.tradingAccountId;
    const returnTo = stateEntry?.returnTo;

    // TEMPORARY DIAGNOSTICS — context recovery trace.
    this.logger.log(
      '\n========== SHOONYA CONTEXT RECOVERY ==========\n' +
        `State from URL                 : ${stateParam ?? '(none)'}\n` +
        `State from Cookie              : ${cookieVal ?? '(none)'}\n` +
        `Decoded tradingAccountId (URL) : ${decodedFromState?.tradingAccountId ?? '(none)'}\n` +
        `Decoded tradingAccountId (ck)  : ${decodedFromCookie?.tradingAccountId ?? '(none)'}\n` +
        `Decoded returnTo               : ${(decodedFromState?.returnTo ?? decodedFromCookie?.returnTo) ?? '(none)'}\n` +
        `Final tradingAccountId         : ${tradingAccountId ?? '(undefined)'}\n` +
        `Final returnTo                 : ${returnTo ?? '(undefined)'}\n` +
        '=============================================',
    );

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
      // TEMPORARY DIAGNOSTICS — exact failure point.
      this.logger.error(
        '\n========== SHOONYA CONTEXT FAILURE ==========\n' +
          `Why tradingAccountId undefined : neither the state param nor the cookie yielded a tradingAccountId\n` +
          `state parameter present?       : ${!!stateParam}\n` +
          `cookie present?                : ${!!cookieVal}\n` +
          `cookie decoded?                : ${!!decodedFromCookie}\n` +
          `state decoded?                 : ${!!decodedFromState}\n` +
          `cookie value                   : ${cookieVal ?? '(none)'}\n` +
          `decoded object                 : ${JSON.stringify(decodedFromState ?? decodedFromCookie ?? null)}\n` +
          '===========================================',
      );
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

    // TEMPORARY DIAGNOSTICS — context recovered.
    this.logger.log(
      '\n========== SHOONYA CONTEXT RECOVERED ==========\n' +
        `TradingAccountId     : ${tradingAccountId}\n` +
        `ReturnTo             : ${returnTo ?? '(none)'}\n` +
        `Source               : ${decodedFromState?.tradingAccountId ? 'state param' : 'cookie'}\n` +
        '=============================================',
    );

    this.logger.debug(
      `[Shoonya OAuth] callback started | broker=SHOONYA masterAccountId=${tradingAccountId}`,
    );

    try {
      this.logger.log(
        `[Shoonya] TradingAccount lookup started | id=${tradingAccountId}`,
      );
      const account = await this.prisma.tradingAccount.findUnique({
        where: { id: tradingAccountId },
      });
      // TEMPORARY DIAGNOSTICS — account lookup result.
      this.logger.log(
        '\n========== SHOONYA ACCOUNT LOOKUP ==========\n' +
          `ID                   : ${tradingAccountId}\n` +
          `Result Found?        : ${!!account}\n` +
          `Broker               : ${account?.broker ?? '(none)'}\n` +
          `UserId (clientId)    : ${account?.clientId ?? '(none)'}\n` +
          `Owner userId         : ${account?.userId ?? '(none)'}\n` +
          `AccountType          : ${account?.accountType ?? '(none)'}\n` +
          `MasterAccount?       : ${account?.accountType === 'MASTER'}\n` +
          '==========================================',
      );
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
