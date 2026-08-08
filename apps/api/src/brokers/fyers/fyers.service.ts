import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';

/**
 * Result of the post-persist credential validation (Sprint 6.2.13-fyers-fix).
 * The OAuth callback treats a failed validation as an authentication failure
 * and never redirects as success.
 */
export interface FyersSessionValidation {
  ok: boolean;
  reason?: string;
  userId?: string;
}

@Injectable()
export class FyersService {
  private readonly logger = new Logger('FyersService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Persist the freshly-generated Fyers session, mirroring the working
   * Zerodha / ICICI reconnect persistence pattern EXACTLY:
   *   - overwrite the encrypted access token,
   *   - refresh userId / userName from the live profile,
   *   - refresh loginTime (Zerodha) + the account's lastHeartbeat "last
   *     connected" timestamp (ICICI) on BOTH create and update — the previous
   *     Fyers implementation refreshed neither on reconnect, leaving a stale
   *     session behind the success redirect.
   *
   * userId / userName are NOT-NULL columns; Prisma treats `undefined` on an
   * update as "leave unchanged", which is how a partial live profile used to
   * silently keep a stale/mismatched API id. We coerce to '' so the row is
   * written deterministically and the downstream validation can reject it.
   */
  async saveSession(
    tradingAccountId: string,
    session: any,
    profile: any,
  ) {
    const now = new Date();
    const accessToken = session?.access_token ?? '';
    const userId = profile?.userId ?? '';
    const userName = profile?.userName ?? profile?.userId ?? '';

    await this.prisma.brokerSession.upsert({
      where: {
        tradingAccountId_broker: {
          tradingAccountId,
          broker: 'FYERS',
        },
      },
      update: {
        encryptedAccessToken: this.encryption.encrypt(accessToken),
        publicToken: null,
        userId,
        userName,
        loginTime: now,
      },
      create: {
        tradingAccountId,
        broker: 'FYERS',
        encryptedAccessToken: this.encryption.encrypt(accessToken),
        publicToken: null,
        userId,
        userName,
        loginTime: now,
      },
    });

    await this.prisma.tradingAccount.update({
      where: {
        id: tradingAccountId,
      },
      data: {
        connectionStatus: 'CONNECTED',
        lastHeartbeat: now,
      },
    });
  }

  /**
   * Reload the just-persisted Fyers session THE SAME WAY the adapter factory
   * (BrokerService.loadContext → buildAdapter) loads it — by the
   * (tradingAccountId, broker) unique key, decrypting the access token — and
   * verify every credential the Fyers adapter needs is present and correct.
   * Returns { ok:false, reason } so the callback can fail the redirect instead
   * of falsely reporting success.
   */
  async validatePersistedSession(
    tradingAccountId: string,
  ): Promise<FyersSessionValidation> {
    const session = await this.prisma.brokerSession.findUnique({
      where: {
        tradingAccountId_broker: {
          tradingAccountId,
          broker: 'FYERS',
        },
      },
    });

    if (!session) {
      return { ok: false, reason: 'No persisted Fyers session found after save' };
    }
    if (session.broker !== 'FYERS') {
      return { ok: false, reason: 'Persisted session belongs to a different broker' };
    }
    if (session.tradingAccountId !== tradingAccountId) {
      return { ok: false, reason: 'Persisted session belongs to a different master account' };
    }

    let accessToken = '';
    try {
      accessToken = this.encryption.decrypt(session.encryptedAccessToken);
    } catch {
      return { ok: false, reason: 'Persisted access token could not be decrypted' };
    }
    if (!accessToken) {
      return { ok: false, reason: 'Persisted access token is empty' };
    }
    if (!session.userId) {
      return { ok: false, reason: 'Persisted broker user id (API ID) is empty' };
    }

    return { ok: true, userId: session.userId };
  }
}
