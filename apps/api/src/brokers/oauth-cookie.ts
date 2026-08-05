import type { Request, Response } from 'express';

/**
 * Sprint 6.1.1 — Minimal cookie helpers for the OAuth flow.
 *
 * Reads / writes cookies directly through Express Response / Request
 * so we do not need to add `cookie-parser` as a runtime dependency.
 * Only used to shuttle the OAuth `stateId` between /login and
 * /callback of the broker controllers.
 */

export const OAUTH_STATE_COOKIE = 'cts_oauth_state';

const COOKIE_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * Set an HttpOnly cookie carrying the OAuth state id.
 *
 * `sameSite` defaults to 'Lax' — still transmitted on the top-level GET
 * redirect issued by GET-callback brokers (Zerodha/Fyers/Shoonya), so their
 * behaviour is unchanged. Pass 'None' for brokers whose provider returns via a
 * cross-site POST (ICICI Direct/Breeze), on which Lax cookies are NOT sent;
 * SameSite=None mandates Secure, so Secure is forced in that case.
 */
export function setOAuthStateCookie(
  res: Response,
  stateId: string,
  sameSite: 'Lax' | 'None' = 'Lax',
): void {
  const isProd = process.env.NODE_ENV === 'production';
  const secure = isProd || sameSite === 'None';
  res.setHeader('Set-Cookie', [
    `${OAUTH_STATE_COOKIE}=${encodeURIComponent(stateId)}`,
    'Path=/',
    'HttpOnly',
    `Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}`,
    `SameSite=${sameSite}`,
    ...(secure ? ['Secure'] : []),
  ].join('; '));
}

export function clearOAuthStateCookie(
  res: Response,
  sameSite: 'Lax' | 'None' = 'Lax',
): void {
  const isProd = process.env.NODE_ENV === 'production';
  const secure = isProd || sameSite === 'None';
  res.setHeader('Set-Cookie', [
    `${OAUTH_STATE_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'Max-Age=0',
    `SameSite=${sameSite}`,
    ...(secure ? ['Secure'] : []),
  ].join('; '));
}

/**
 * Extract a cookie value from the raw `Cookie` header.
 */
export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers?.cookie;
  if (!raw || typeof raw !== 'string') return undefined;
  for (const part of raw.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) {
      try {
        return decodeURIComponent(rest.join('='));
      } catch {
        return rest.join('=');
      }
    }
  }
  return undefined;
}
