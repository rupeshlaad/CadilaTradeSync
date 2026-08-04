import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Broker } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';
import {
  RawBrokerTrade,
  TradeEvent,
  TradeEventSource,
  TradeEventStatus,
  TradeSide,
} from './trade-event';

export interface NormalizationOutcome {
  ok: boolean;
  event: TradeEvent | null;
  reason: string | null;
}

/**
 * Turns a broker-shaped payload into a canonical TradeEvent.
 *
 * Guarantees on success:
 *   - Non-empty brokerOrderId / brokerSymbol.
 *   - side is 'BUY' or 'SELL' (rejected otherwise).
 *   - quantity is a positive finite number.
 *   - price is a finite number or explicitly null (some fills carry
 *     price=0 or omit it; we do not fabricate a value).
 *   - instrumentId / contractKey / strategyId are best-effort — nulls
 *     are surfaced up to the validation layer to decide whether the
 *     event may proceed.
 *
 * On failure the outcome contains a human-readable reason so the
 * intake service can attach it to a REJECTED record for the admin UI.
 */
@Injectable()
export class TradeEventNormalizationService {
  private readonly logger = new Logger('TradeEventNormalization');

  constructor(private readonly prisma: PrismaService) {}

  async normalize(raw: RawBrokerTrade): Promise<NormalizationOutcome> {
    // ---- shape checks -----------------------------------------------------
    if (!raw || typeof raw !== 'object') {
      return this.reject('Payload is not an object');
    }

    const source = raw.source ?? TradeEventSource.UNKNOWN;

    if (!raw.broker || !(raw.broker in Broker)) {
      return this.reject(`Unknown broker "${String(raw.broker)}"`);
    }
    const broker = raw.broker as Broker;

    const masterAccountId =
      typeof raw.masterAccountId === 'string' ? raw.masterAccountId.trim() : '';
    if (!masterAccountId) {
      return this.reject('masterAccountId is required');
    }

    const brokerOrderId = this.coerceString(raw.brokerOrderId);
    if (!brokerOrderId) {
      return this.reject('brokerOrderId is required');
    }
    const brokerExecutionId = this.coerceString(raw.brokerExecutionId) || null;

    const brokerSymbol =
      typeof raw.brokerSymbol === 'string' ? raw.brokerSymbol.trim() : '';
    if (!brokerSymbol) {
      return this.reject('brokerSymbol is required');
    }

    const side = this.coerceSide(raw.side);
    if (!side) {
      return this.reject(`Invalid side "${String(raw.side)}"`);
    }

    const quantity = this.coerceNumber(raw.quantity);
    if (quantity === null || !Number.isFinite(quantity) || quantity <= 0) {
      return this.reject(`Invalid quantity "${String(raw.quantity)}"`);
    }

    const priceRaw =
      raw.price === undefined || raw.price === null ? null : this.coerceNumber(raw.price);
    const price =
      priceRaw === null
        ? null
        : Number.isFinite(priceRaw)
        ? priceRaw
        : null;

    const brokerTimestamp = this.coerceIsoTimestamp(raw.brokerTimestamp);
    const rawStatus =
      raw.rawStatus === undefined || raw.rawStatus === null
        ? null
        : String(raw.rawStatus).trim() || null;

    // ---- best-effort resolution ------------------------------------------
    let instrumentId: string | null = null;
    let contractKey: string | null = null;
    try {
      const mapping = await this.prisma.instrumentBroker.findUnique({
        where: {
          broker_brokerSymbol: {
            broker,
            brokerSymbol,
          },
        },
        include: { instrument: true },
      });
      if (mapping) {
        instrumentId = mapping.instrumentId;
        contractKey = mapping.instrument?.contractKey ?? null;
      }
    } catch (err) {
      // Instrument resolution is best-effort at normalization time.
      // The validation service enforces mapping availability strictly.
      this.logger.warn(
        `Instrument lookup failed for ${broker} ${brokerSymbol}: ${(err as Error).message}`,
      );
    }

    let strategyId: string | null = null;
    try {
      // "Strategy for the trade" = a strategy whose master trading
      // account is the one that reported the fill. If multiple
      // strategies share the same master (unusual but permitted by the
      // schema), pick the most recently updated one — the validation
      // service will still enforce that the picked strategy is RUNNING.
      const strategy = await this.prisma.strategy.findFirst({
        where: { tradingAccountId: masterAccountId },
        orderBy: { updatedAt: 'desc' },
        select: { id: true },
      });
      strategyId = strategy?.id ?? null;
    } catch (err) {
      this.logger.warn(
        `Strategy lookup failed for master ${masterAccountId}: ${(err as Error).message}`,
      );
    }

    const event: TradeEvent = {
      id: randomUUID(),
      source,
      broker,
      masterAccountId,
      strategyId,
      brokerOrderId,
      brokerExecutionId,
      brokerSymbol,
      instrumentId,
      contractKey,
      side,
      quantity,
      price,
      rawStatus,
      status: TradeEventStatus.NORMALIZED,
      brokerTimestamp,
      receivedAt: new Date().toISOString(),
      raw: raw.raw ?? raw,
    };

    return { ok: true, event, reason: null };
  }

  // -----------------------------------------------------------------------
  // helpers
  // -----------------------------------------------------------------------

  private reject(reason: string): NormalizationOutcome {
    return { ok: false, event: null, reason };
  }

  private coerceString(v: unknown): string {
    if (v === null || v === undefined) return '';
    return String(v).trim();
  }

  private coerceSide(v: unknown): TradeSide | null {
    if (typeof v !== 'string') return null;
    const up = v.trim().toUpperCase();
    if (up === 'BUY' || up === 'B') return 'BUY';
    if (up === 'SELL' || up === 'S') return 'SELL';
    return null;
  }

  private coerceNumber(v: unknown): number | null {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return v;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }

  private coerceIsoTimestamp(
    v: string | number | Date | null | undefined,
  ): string | null {
    if (v === null || v === undefined || v === '') return null;
    const d = v instanceof Date ? v : new Date(v as any);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
  }
}
