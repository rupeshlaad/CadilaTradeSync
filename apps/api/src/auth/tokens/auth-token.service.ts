import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { AuthTokenPurpose } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.module';

/**
 * Sprint 1 — Secure single-use, expiring auth tokens (email verification and
 * password reset). ONLY a SHA-256 hash of the token is persisted; the raw
 * token exists only inside the email link. Tokens are single-use (usedAt) and
 * time-boxed (expiresAt). Never logged.
 */
@Injectable()
export class AuthTokenService {
  constructor(private readonly prisma: PrismaService) {}

  private hash(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Issues a fresh token for a user+purpose. Any prior unused tokens of the
   * same purpose are invalidated first so only the latest link works.
   * Returns the RAW token (to embed in the email link).
   */
  async issue(userId: string, purpose: AuthTokenPurpose, ttlMs: number): Promise<string> {
    const raw = randomBytes(32).toString('hex');
    const tokenHash = this.hash(raw);
    const expiresAt = new Date(Date.now() + ttlMs);

    await this.prisma.$transaction([
      this.prisma.authToken.updateMany({
        where: { userId, purpose, usedAt: null },
        data: { usedAt: new Date() },
      }),
      this.prisma.authToken.create({
        data: { userId, purpose, tokenHash, expiresAt },
      }),
    ]);

    return raw;
  }

  /**
   * Consumes a raw token atomically: validates it exists, matches the purpose,
   * is unused and unexpired, then marks it used. Returns the owning userId or
   * null if invalid. Single-use is guaranteed by the conditional updateMany.
   */
  async consume(raw: string, purpose: AuthTokenPurpose): Promise<string | null> {
    if (!raw || typeof raw !== 'string') return null;
    const tokenHash = this.hash(raw);

    const token = await this.prisma.authToken.findUnique({ where: { tokenHash } });
    if (!token) return null;
    if (token.purpose !== purpose) return null;
    if (token.usedAt) return null;
    if (token.expiresAt.getTime() < Date.now()) return null;

    const marked = await this.prisma.authToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (marked.count !== 1) return null;

    return token.userId;
  }
}
