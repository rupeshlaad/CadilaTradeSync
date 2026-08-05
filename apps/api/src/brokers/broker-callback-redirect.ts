import { AccountType } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.module';

/**
 * Sprint 6.1 — Shared broker OAuth callback redirect logic.
 *
 * Reused by both the Zerodha and Fyers callback controllers so a
 * single implementation decides where the browser lands after broker
 * authentication:
 *
 *   - MASTER  trading accounts → Admin app (ADMIN_APP_URL, default 3001)
 *   - FOLLOWER trading accounts → Web  app (WEB_APP_URL,   default 3000)
 *
 * On success the destination is the account's landing page with a
 * `connected=1` query string. On failure the destination is the
 * portfolio's broker-accounts list with an `error=<message>` query
 * string so the UI can render a dismissable toast.
 */

export type BrokerCallbackResult =
  | { ok: true }
  | { ok: false; error: string };

const DEFAULT_ADMIN_URL = 'http://localhost:3001';
const DEFAULT_WEB_URL = 'http://localhost:3000';

function stripTrailingSlash(v: string): string {
  return v.replace(/\/$/, '');
}

function adminAppBaseUrl(): string {
  return stripTrailingSlash(process.env.ADMIN_APP_URL ?? DEFAULT_ADMIN_URL);
}

function webAppBaseUrl(): string {
  return stripTrailingSlash(process.env.WEB_APP_URL ?? DEFAULT_WEB_URL);
}

/**
 * Look up the trading account's role and return the destination URL
 * for a broker OAuth callback outcome. If the account cannot be
 * resolved we fall back to the ADMIN app landing page — matching the
 * legacy behaviour so an unknown OAuth roundtrip never leaves the
 * user on a raw JSON page.
 */
export async function buildBrokerCallbackRedirect(
  prisma: PrismaService,
  tradingAccountId: string | undefined,
  result: BrokerCallbackResult,
): Promise<string> {
  let accountType: AccountType | null = null;
  if (tradingAccountId) {
    const acc = await prisma.tradingAccount.findUnique({
      where: { id: tradingAccountId },
      select: { accountType: true },
    });
    accountType = acc?.accountType ?? null;
  }

  const isFollower = accountType === AccountType.FOLLOWER;
  const base = isFollower ? webAppBaseUrl() : adminAppBaseUrl();

  let path: string;
  if (result.ok && tradingAccountId) {
    path = isFollower
      ? `/dashboard/broker-accounts`
      : `/dashboard/master-accounts/${tradingAccountId}/dashboard`;
  } else {
    path = isFollower
      ? `/dashboard/broker-accounts`
      : `/dashboard/master-accounts`;
  }

  const url = new URL(`${base}${path}`);
  if (result.ok) {
    url.searchParams.set('connected', '1');
    if (tradingAccountId) url.searchParams.set('accountId', tradingAccountId);
  } else {
    url.searchParams.set('error', result.error);
  }
  return url.toString();
}
