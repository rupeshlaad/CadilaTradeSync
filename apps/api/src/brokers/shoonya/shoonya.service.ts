import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.module';
import { EncryptionService } from '../../encryption/encryption.service';

/**
 * Sprint 6.2.0 — Shoonya OAuth session persistence + post-persist validation.
 *
 * Migrated from the retired QuickAuth (password + TOTP) server-side login to
 * the OAuth authorization-code flow. The controller now drives the redirect +
 * `GenAcsTok` token exchange (mirroring Fyers/Upstox); this service only
 * persists the resulting daily access token and validates that persistence,
 * exactly like FyersService/UpstoxService so both portals share one pattern.
 */
export interface ShoonyaSessionValidation {
  ok: boolean;
  reason?: string;
  userId?: string;
}

@Injectable()
export class ShoonyaService {
  private readonly logger = new Logger('ShoonyaService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  /**
   * Persist the freshly-generated Shoonya OAuth session, mirroring the working
   * Fyers / Upstox reconnect persistence pattern EXACTLY:
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
    const userId = profile?.userId ?? session?.actid ?? session?.uid ?? '';
    const userName =
      profile?.userName ?? session?.userName ?? profile?.userId ?? '';
    const expiresAt = shoonyaExpiry(session?.expires_in);

    await this.prisma.brokerSession.upsert({
      where: {
        tradingAccountId_broker: {
          tradingAccountId,
          broker: 'SHOONYA',
        },
      },
      update: {
        encryptedAccessToken: this.encryption.encrypt(accessToken),
        userId,
        userName,
        expiresAt,
        loginTime: now,
      },
      create: {
        tradingAccountId,
        broker: 'SHOONYA',
        encryptedAccessToken: this.encryption.encrypt(accessToken),
        userId,
        userName,
        expiresAt,
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
   * Reload the just-persisted Shoonya session THE SAME WAY the adapter factory
   * (BrokerService.loadContext → buildAdapter) loads it — by the
   * (tradingAccountId, broker=SHOONYA) unique key, decrypting the access token
   * — and verify every credential the adapter needs is present. Mirrors
   * FyersService.validatePersistedSession (no second live probe: the callback
   * already exercised the token via `getProfile()` before persisting, and a
   * mandatory re-probe would spuriously fail during a known Noren gateway 502).
   */
  async validatePersistedSession(
    tradingAccountId: string,
  ): Promise<ShoonyaSessionValidation> {
    const session = await this.prisma.brokerSession.findUnique({
      where: {
        tradingAccountId_broker: {
          tradingAccountId,
          broker: 'SHOONYA',
        },
      },
    });

    if (!session) {
      return { ok: false, reason: 'No persisted Shoonya session found after save' };
    }
    if (session.broker !== 'SHOONYA') {
      return { ok: false, reason: 'Persisted session belongs to a different broker' };
    }
    if (session.tradingAccountId !== tradingAccountId) {
      return {
        ok: false,
        reason: 'Persisted session belongs to a different master account',
      };
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

/**
 * Sprint 6.1.7 / 6.2.0 — Shoonya access tokens expire daily. `GenAcsTok`
 * returns `expires_in` as an absolute epoch (seconds) when present; use it
 * directly. Otherwise fall back to the next 06:00 IST (00:30 UTC) boundary so
 * the shared BrokerSession lifecycle can mark the token EXPIRED and require a
 * fresh OAuth login.
 */
function shoonyaExpiry(expiresIn?: string | number): Date {
  const epoch = Number(expiresIn);
  if (Number.isFinite(epoch) && epoch > 1_000_000_000) {
    return new Date(epoch * 1000);
  }
  const d = new Date();
  const expiry = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 30, 0),
  );
  if (expiry.getTime() <= d.getTime()) {
    expiry.setUTCDate(expiry.getUTCDate() + 1);
  }
  return expiry;
}
