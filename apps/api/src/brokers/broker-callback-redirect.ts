import { AccountType } from '@prisma/client';

import type { PrismaService } from '../prisma/prisma.module';

/**
 * Sprint 6.1 / 6.1.1 — Shared broker OAuth callback redirect logic.
 *
 * Sprint 6.1 added portal-aware defaults (Master → Admin app,
 * Follower → Web app). Sprint 6.1.1 adds `returnTo` support so
 * that a Reconnect initiated from the Master Portal lands back on
 * the *same page* the user came from, and a Reconnect initiated
 * from the Follower Broker Accounts page lands back there. The
 * `returnTo` value is validated against the configured base URLs
 * (and relative paths are always allowed) so the redirect cannot
 * be turned into an open-redirect vector.
 */

export type BrokerCallbackResult =
  | { ok: true }
  | { ok: false; error: string };

const DEFAULT_ADMIN_URL = 'http://localhost:3001';
const DEFAULT_WEB_URL = 'http://localhost:3000';

function stripTrailingSlash(v: string): string {
  return v.replace(/\/$/, '');
}

export function adminAppBaseUrl(): string {
  return stripTrailingSlash(process.env.ADMIN_APP_URL ?? DEFAULT_ADMIN_URL);
}

export function webAppBaseUrl(): string {
  return stripTrailingSlash(process.env.WEB_APP_URL ?? DEFAULT_WEB_URL);
}

/**
 * Compute a safe absolute redirect target from an untrusted `returnTo`.
 * Rules:
 *   - Relative paths (e.g. `/dashboard/master-accounts`) are always
 *     accepted and joined onto the configured portal base URL.
 *   - Absolute URLs are only accepted when their origin matches the
 *     admin or web base URL (open-redirect guard).
 *   - Anything else falls back to `null` and the caller uses the
 *     portal-aware default landing page.
 */
export function coerceSafeReturnTo(
  returnTo: string | undefined,
  portalBase: string,
): string | null {
  if (!returnTo) return null;
  const trimmed = returnTo.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return portalBase + trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    const admin = new URL(adminAppBaseUrl());
    const web = new URL(webAppBaseUrl());
    if (
      parsed.origin === admin.origin ||
      parsed.origin === web.origin ||
      parsed.origin === portalBase
    ) {
      return parsed.toString();
    }
  } catch {
    return null;
  }
  return null;
}

export interface BrokerCallbackRedirectOptions {
  tradingAccountId?: string;
  returnTo?: string;
  result: BrokerCallbackResult;
}

export async function buildBrokerCallbackRedirect(
  prisma: PrismaService,
  optsOrTradingAccountId:
    | BrokerCallbackRedirectOptions
    | (string | undefined),
  legacyResult?: BrokerCallbackResult,
): Promise<string> {
  // Legacy signature: (prisma, tradingAccountId, result).
  const opts: BrokerCallbackRedirectOptions =
    typeof optsOrTradingAccountId === 'object' && optsOrTradingAccountId !== null
      ? optsOrTradingAccountId
      : { tradingAccountId: optsOrTradingAccountId, result: legacyResult! };

  const { tradingAccountId, returnTo, result } = opts;

  let accountType: AccountType | null = null;
  if (tradingAccountId) {
    const acc = await prisma.tradingAccount.findUnique({
      where: { id: tradingAccountId },
      select: { accountType: true },
    });
    accountType = acc?.accountType ?? null;
  }

  const isFollower = accountType === AccountType.FOLLOWER;
  const portalBase = isFollower ? webAppBaseUrl() : adminAppBaseUrl();

  // 1) Preserve origin if provided and safe.
  const safeReturnTo = coerceSafeReturnTo(returnTo, portalBase);

  // 2) Fall back to portal-aware default landing pages.
  let base: string;
  if (safeReturnTo) {
    base = safeReturnTo;
  } else if (result.ok && tradingAccountId && !isFollower) {
    base = `${portalBase}/dashboard/master-accounts/${tradingAccountId}/dashboard`;
  } else if (isFollower) {
    base = `${portalBase}/dashboard/broker-accounts`;
  } else {
    base = `${portalBase}/dashboard/master-accounts`;
  }

  const url = new URL(base);
  if (result.ok) {
    url.searchParams.set('connected', '1');
    if (tradingAccountId) url.searchParams.set('accountId', tradingAccountId);
  } else {
    url.searchParams.set('error', result.error);
  }
  return url.toString();
}
