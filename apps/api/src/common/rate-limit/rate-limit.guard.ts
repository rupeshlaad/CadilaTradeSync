import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Inject,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import { REDIS_CLIENT } from '../../redis/redis.module';
import { RATE_LIMIT_KEY, RateLimitOptions } from './rate-limit.decorator';

/**
 * Sprint 1 — Focused, dependency-free rate limiter for authentication abuse
 * (register / login / forgot-password / verification-resend). Uses the app's
 * existing Redis (INCR + EXPIRE fixed window). If Redis is unavailable it
 * fails OPEN for legitimate traffic but still enforces a process-local
 * in-memory window so a single instance is never left unprotected.
 *
 * Deliberately NOT a heavyweight framework — one small guard applied only
 * where it matters.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly memory = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return true;

    const req = context.switchToHttp().getRequest();
    const ip = this.clientIp(req);
    const key = `ratelimit:${options.keyPrefix}:${ip}`;

    const { count, ttl } = await this.increment(key, options.windowSec);

    if (count > options.limit) {
      const retryAfter = ttl > 0 ? ttl : options.windowSec;
      const res = context.switchToHttp().getResponse();
      res?.header?.('Retry-After', String(retryAfter));
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests. Please wait and try again.',
          error: 'Too Many Requests',
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private clientIp(req: any): string {
    const fwd = req?.headers?.['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
    return req?.ip || req?.socket?.remoteAddress || 'unknown';
  }

  private async increment(
    key: string,
    windowSec: number,
  ): Promise<{ count: number; ttl: number }> {
    try {
      const count = await this.redis.incr(key);
      if (count === 1) {
        await this.redis.expire(key, windowSec);
      }
      const ttl = await this.redis.ttl(key);
      return { count, ttl };
    } catch (err) {
      // Redis unavailable — degrade to a process-local fixed window.
      this.logger.warn(`Redis rate-limit unavailable, using in-memory fallback: ${String(err)}`);
      return this.incrementMemory(key, windowSec);
    }
  }

  private incrementMemory(key: string, windowSec: number): { count: number; ttl: number } {
    const now = Date.now();
    const entry = this.memory.get(key);
    if (!entry || entry.resetAt <= now) {
      const resetAt = now + windowSec * 1000;
      this.memory.set(key, { count: 1, resetAt });
      return { count: 1, ttl: windowSec };
    }
    entry.count += 1;
    return { count: entry.count, ttl: Math.ceil((entry.resetAt - now) / 1000) };
  }
}
