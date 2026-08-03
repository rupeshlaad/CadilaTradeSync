import { Controller, Get, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { ZerodhaAdapter } from './zerodha.adapter';
import { ZerodhaService } from './zerodha.service';

const loginStore = new Map<string, string>();

function getAdminBaseUrl(): string {
  return (process.env.ADMIN_APP_URL ?? 'http://localhost:3001').replace(
    /\/$/,
    '',
  );
}

function buildAdminUrl(path: string, params?: Record<string, string>): string {
  const base = getAdminBaseUrl();
  const url = new URL(`${base}${path.startsWith('/') ? path : `/${path}`}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

@Controller('brokers/zerodha')
export class ZerodhaController {
  private readonly adapter = new ZerodhaAdapter();

  constructor(private readonly zerodhaService: ZerodhaService) {}

  @Get('login')
  login(
    @Query('tradingAccountId') tradingAccountId: string,
    @Res() res: Response,
  ) {
    // Preserve reconnect context via the existing in-memory store mechanism.
    loginStore.set('current', tradingAccountId);

    return res.redirect(this.adapter.getLoginUrl());
  }

  @Get('callback')
  async callback(
    @Query('request_token') requestToken: string,
    @Query('status') status: string | undefined,
    @Res() res: Response,
  ) {
    const tradingAccountId = loginStore.get('current');

    // Zerodha OAuth sometimes signals user-side failure via `status` param.
    if (status && status !== 'success') {
      return res.redirect(
        buildAdminUrl('/dashboard/master-accounts', {
          error: `Broker login ${status}`,
        }),
      );
    }

    if (!requestToken) {
      return res.redirect(
        buildAdminUrl('/dashboard/master-accounts', {
          error: 'Missing request token from broker',
        }),
      );
    }

    try {
      const session = await this.adapter.exchangeToken(requestToken);
      const profile = await this.adapter.getProfile();

      if (!tradingAccountId) {
        // Session was created upstream but we lost the reconnect context —
        // still land the user in the admin app, not on a raw JSON page.
        return res.redirect(
          buildAdminUrl('/dashboard/master-accounts', {
            error: 'Reconnect context missing. Please retry from the account.',
          }),
        );
      }

      loginStore.delete('current');

      await this.zerodhaService.saveSession(
        tradingAccountId,
        session,
        profile,
      );

      return res.redirect(
        buildAdminUrl(
          `/dashboard/master-accounts/${tradingAccountId}/dashboard`,
          { connected: '1' },
        ),
      );
    } catch (err: any) {
      // Never expose raw exception JSON to the browser.
      const msg =
        (err && (err.message || err.error_type)) || 'Broker authentication failed';
      return res.redirect(
        buildAdminUrl('/dashboard/master-accounts', {
          error: String(msg),
        }),
      );
    }
  }
}
