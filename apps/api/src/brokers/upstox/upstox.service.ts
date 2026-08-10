import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';

/**
 * Result of the post-persist credential validation (mirrors FyersService).
 * The OAuth callback treats a failed validation as an authentication failure
 * and never redirects as success.
 */
export interface UpstoxSessionValidation {
  ok: boolean;
  reason?: string;
  userId?: string;
}

@Injectable()
export class UpstoxService {
  private readonly logger = new Logger('UpstoxService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Persist the freshly-generated Upstox session, mirroring the working
   * Fyers / Zerodha / ICICI reconnect persistence pattern EXACTLY:
   *   - overwrite the encrypted daily access token,
   *   - refresh userId / userName from the live profile,
   *   - refresh loginTime + the account's lastHeartbeat on BOTH create and
   *     update (a reconnect must not leave a stale session behind a success
   *     redirect).
   *
   * userId / userName are NOT-NULL columns; Prisma treats `undefined` on an
   * update as "leave unchanged", so we coerce to '' to write the row
   * deterministically and let validation reject an empty id.
   */
  async saveSession(tradingAccountId: string, session: any, profile: any) {
    const now = new Date();
    const accessToken = session?.access_token ?? '';
    const userId = profile?.userId ?? session?.user_id ?? '';
    const userName = profile?.userName ?? profile?.userId ?? session?.user_name ?? '';

    await this.prisma.brokerSession.upsert({
      where: {
        tradingAccountId_broker: {
          tradingAccountId,
          broker: 'UPSTOX',
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
        broker: 'UPSTOX',
        encryptedAccessToken: this.encryption.encrypt(accessToken),
        publicToken: null,
        userId,
        userName,
        loginTime: now,
      },
    });

    await this.prisma.tradingAccount.update({
      where: { id: tradingAccountId },
      data: {
        connectionStatus: 'CONNECTED',
        lastHeartbeat: now,
      },
    });
  }

  /**
   * Reload the just-persisted Upstox session THE SAME WAY the adapter factory
   * (BrokerService.loadContext → buildAdapter) loads it — by the
   * (tradingAccountId, broker=UPSTOX) unique key, decrypting the access token
   * — and verify every credential the adapter needs is present and correct.
   */
  async validatePersistedSession(
    tradingAccountId: string,
  ): Promise<UpstoxSessionValidation> {
    const session = await this.prisma.brokerSession.findUnique({
      where: {
        tradingAccountId_broker: {
          tradingAccountId,
          broker: 'UPSTOX',
        },
      },
    });

    if (!session) {
      return { ok: false, reason: 'No persisted Upstox session found after save' };
    }
    if (session.broker !== 'UPSTOX') {
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
      return { ok: false, reason: 'Persisted broker user id is empty' };
    }

    return { ok: true, userId: session.userId };
  }
}
