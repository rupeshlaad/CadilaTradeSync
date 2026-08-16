import { SetMetadata } from '@nestjs/common';

export const RATE_LIMIT_KEY = 'cts_rate_limit';

export interface RateLimitOptions {
  /** Max requests allowed within the window. */
  limit: number;
  /** Window size in seconds. */
  windowSec: number;
  /** Stable prefix identifying the protected action (e.g. "auth:login"). */
  keyPrefix: string;
}

/**
 * Sprint 1 — Declarative rate limit for a route handler. Enforced by
 * RateLimitGuard using the existing Redis client (in-memory fallback).
 */
export const RateLimit = (options: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, options);
