import { createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';

import { readCookie } from '../oauth-cookie';
import {
  BrokerCallbackResult,
  adminAppBaseUrl,
  coerceSafeReturnTo,
  webAppBaseUrl,
} from '../broker-callback-redirect';

/**
 * Sprint 6.2.0 Hotfix-2 — self-contained OAuth context for ICICI Direct.
 *
 * The Breeze login (client id + password + OTP) takes minutes and the callback
 * arrives as a *separate* cross-site POST. The previous server-side stores
 * (in-memory Map / Redis, keyed by a cookie) lost the context whenever the API
 * process recycled or Redis was not running locally, so the callback fell
 * through to the account-type-inferred default and landed on the WRONG portal
 * (Master) with "Reconnect context missing".
 *
 * This carries the ENTIRE context inside a single HMAC-signed cookie
 * (`cts_icici_oauth`), so no server-side store is required and the context
 * cannot be lost to a restart/replica. The callback then rebuilds the redirect
 * from ONLY the stored `portal` + `returnTo` — it never infers the portal and
 * never defaults to Master.
 */

export type Portal = 'FOLLOWER' | 'MASTER';

export interface ICICIOAuthState {
  stateId: string;
  tradingAccountId: string;
  userId: string;
  broker: 'ICICI_DIRECT';
  portal: Portal;
  returnTo?: string;
  reconnectMode: boolean;
}

export const ICICI_OAUTH_COOKIE = 'cts_icici_oauth';
const COOKIE_MAX_AGE_SECONDS = 15 * 60;

function secret(): string {
  return process.env.JWT_SECRET ?? 'cts-icici-oauth-fallback-secret';
}

function sign(payloadB64: string): string {
  return createHmac('sha256', secret()).update(payloadB64).digest('base64url');
}

export function encodeICICIState(state: ICICIOAuthState): string {
  const payload = Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function decodeICICIState(value: string | undefined): ICICIOAuthState | null {
  if (!value) return null;
  const idx = value.lastIndexOf('.');
  if (idx <= 0) return null;
  const payload = value.slice(0, idx);
  const sig = value.slice(idx + 1);
  const expected = sign(payload);
  if (sig.length !== expected.length) return null;
  try {
    if (!timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed.tradingAccountId === 'string' &&
      (parsed.portal === 'FOLLOWER' || parsed.portal === 'MASTER')
    ) {
      return parsed as ICICIOAuthState;
    }
    return null;
  } catch {
    return null;
  }
}

export function setICICIStateCookie(res: Response, value: string): void {
  // SameSite=None (Secure) so the cookie survives Breeze's cross-site POST
  // callback; localhost is treated as a secure context by browsers.
  res.setHeader('Set-Cookie', [
    `${ICICI_OAUTH_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    'SameSite=None',
    'Secure',
  ].join('; '));
}

export function clearICICIStateCookie(res: Response): void {
  res.setHeader('Set-Cookie', [
    `${ICICI_OAUTH_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    'SameSite=None',
    'Secure',
  ].join('; '));
}

export function readICICIStateCookie(req: Request): ICICIOAuthState | null {
  return decodeICICIState(readCookie(req, ICICI_OAUTH_COOKIE));
}

/**
 * Resolve the originating portal strictly from the caller-supplied signal:
 * an explicit `portal` query param first, then the origin encoded in the
 * `returnTo` path. Defaults to FOLLOWER (the user portal) — never Master.
 */
export function resolvePortal(
  portalParam: string | undefined,
  returnTo: string | undefined,
): Portal {
  const p = (portalParam ?? '').toLowerCase();
  if (p === 'master' || p === 'admin') return 'MASTER';
  if (p === 'follower' || p === 'user' || p === 'web') return 'FOLLOWER';
  if (returnTo && returnTo.includes('/dashboard/master-accounts')) return 'MASTER';
  return 'FOLLOWER';
}

/**
 * Build the final browser redirect using ONLY the stored OAuth state's portal
 * and returnTo. It never infers the portal from the account type and never
 * defaults to the Master portal.
 */
export function buildICICIRedirect(opts: {
  state: ICICIOAuthState | null;
  result: BrokerCallbackResult;
}): string {
  const { state, result } = opts;
  const portal: Portal = state?.portal ?? 'FOLLOWER';
  const portalBase = portal === 'MASTER' ? adminAppBaseUrl() : webAppBaseUrl();
  const defaultPath =
    portal === 'MASTER'
      ? '/dashboard/master-accounts'
      : '/dashboard/broker-accounts';

  const safeReturnTo = coerceSafeReturnTo(state?.returnTo, portalBase);
  const base = safeReturnTo ?? portalBase + defaultPath;

  const url = new URL(base);
  if (result.ok) {
    url.searchParams.set('connected', '1');
    if (state?.tradingAccountId) {
      url.searchParams.set('accountId', state.tradingAccountId);
    }
  } else {
    url.searchParams.set('error', result.error);
  }
  return url.toString();
}
