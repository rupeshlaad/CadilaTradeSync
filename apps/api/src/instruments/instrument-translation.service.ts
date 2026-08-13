import { Injectable, Logger } from '@nestjs/common';
import { Broker, Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';

/**
 * Canonical, single-source instrument translation service.
 *
 * THE only public entry point for resolving a broker symbol to its canonical
 * instrument and translating it to another broker's tradable symbol. Every
 * component — the Translation UI (via InstrumentResolverService.translate),
 * CopyTradingService, FollowerExecutionService's caller, and any future
 * Telegram / REST / batch execution path — MUST go through this service so
 * there is never again one lookup path for the UI and a different one for copy
 * trading (the exact cause of the production INSTRUMENT_NOT_FOUND).
 *
 * Guarantees:
 *  - Normalization happens INSIDE the service; no caller normalizes symbols.
 *  - Deterministic multi-stage lookup (exact → normalized → canonical →
 *    trading symbol → instrument token).
 *  - Never throws — an unresolved lookup returns a structured NOT_FOUND with
 *    every attempted key and why it failed.
 *  - Correlation-aware observability of the full lookup.
 */

/** Deterministic exchange preference when a caller does not pin an exchange. */
const EXCHANGE_PREFERENCE = ['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'MCX'];

type InstrumentBrokerRow = Prisma.InstrumentBrokerGetPayload<{
  include: { instrument: true };
}>;

export interface LookupAttempt {
  stage: string;
  key: string;
  matched: boolean;
  reason: string;
}

export interface SourceResolution {
  found: boolean;
  stage: string | null;
  row: InstrumentBrokerRow | null;
  incomingSymbol: string;
  normalizedSymbol: string;
  attempts: LookupAttempt[];
  durationMs: number;
}

export interface TranslationRequest {
  sourceBroker: Broker;
  sourceSymbol: string;
  targetBroker: Broker;
  exchange?: string | null;
  token?: string | null;
  correlationId?: string | null;
}

export interface TranslationSuccess {
  found: true;
  matchedStage: string;

  // Canonical instrument facts.
  instrumentId: string;
  contractKey: string;
  underlying: string;
  exchange: string;
  segment: string;
  exchangeSegment: string;
  instrumentType: string;
  expiry: string | null;
  optionType: string | null;
  strike: number | null;
  lotSize: number;
  tickSize: number | null;

  // Target broker fields (every broker-specific field already stored).
  targetBroker: Broker;
  targetSymbol: string;
  brokerSymbol: string;
  tradingSymbol: string;
  token: string | null;
  instrumentToken: string | null;
  exchangeToken: string | null;

  // Source echo + timing.
  sourceBroker: Broker;
  sourceSymbol: string;
  sourceBrokerSymbol: string;
  lookupDurationMs: number;
}

export interface TranslationNotFound {
  found: false;
  stage: 'SOURCE_NOT_FOUND' | 'TARGET_NOT_FOUND' | 'ERROR';
  reason: string;
  incomingSymbol: string;
  normalizedSymbol: string;
  attempts: LookupAttempt[];
  lookupDurationMs: number;
}

export type TranslationResult = TranslationSuccess | TranslationNotFound;

@Injectable()
export class InstrumentTranslationService {
  private readonly logger = new Logger(InstrumentTranslationService.name);

  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Normalization (INTERNAL — callers never normalize)
  // -------------------------------------------------------------------------

  /**
   * Reduce a broker symbol to its canonical "core" plus a set of broker-symbol
   * variants to probe. Strips the exchange prefix ("NSE:") and common equity
   * suffixes ("-EQ", "-BE", …) but leaves F&O symbols intact (those resolve via
   * exact / token / trading-symbol stages).
   */
  normalize(raw: string): { core: string; variants: string[] } {
    const original = String(raw ?? '').trim();
    const upper = original.toUpperCase();
    const noPrefix = upper.replace(/^[A-Z]+:/, '');
    const core = noPrefix.replace(/-(EQ|BE|BZ|BL|SM|ST|IQ|GB|MF|RR)$/i, '');

    const variants = Array.from(
      new Set(
        [
          original,
          upper,
          noPrefix,
          core,
          `${core}-EQ`,
          `NSE:${core}-EQ`,
          `BSE:${core}-EQ`,
          `NSE:${core}`,
          `BSE:${core}`,
        ].filter((s) => s && s.length > 0),
      ),
    );

    return { core, variants };
  }

  private pickPreferred(
    rows: InstrumentBrokerRow[],
    exchange?: string | null,
  ): InstrumentBrokerRow | null {
    if (rows.length === 0) return null;
    if (exchange) {
      const exact = rows.find(
        (r) => (r.exchange ?? '').toUpperCase() === exchange.toUpperCase(),
      );
      if (exact) return exact;
    }
    for (const pref of EXCHANGE_PREFERENCE) {
      const hit = rows.find((r) => (r.exchange ?? '').toUpperCase() === pref);
      if (hit) return hit;
    }
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------
  // Deterministic source resolution (never throws)
  // -------------------------------------------------------------------------

  /**
   * Resolve a broker symbol to its InstrumentBroker mapping using the
   * deterministic lookup order. Exchange is a PREFERENCE, never a hard filter
   * that can zero out an otherwise valid match (this is what broke copy
   * trading: it constrained by `event.exchange` while the UI did not).
   */
  async resolveSource(
    broker: Broker,
    symbol: string,
    exchange?: string | null,
    token?: string | null,
  ): Promise<SourceResolution> {
    const startedAt = Date.now();
    const attempts: LookupAttempt[] = [];
    const { core, variants } = this.normalize(symbol);

    const finish = (
      row: InstrumentBrokerRow | null,
      stage: string | null,
    ): SourceResolution => ({
      found: !!row,
      stage: row ? stage : null,
      row,
      incomingSymbol: symbol,
      normalizedSymbol: core,
      attempts,
      durationMs: Date.now() - startedAt,
    });

    try {
      // Stage 1 — exact broker symbol (exchange as preference).
      {
        const rows = await this.prisma.instrumentBroker.findMany({
          where: { broker, brokerSymbol: symbol },
          include: { instrument: true },
        });
        const row = this.pickPreferred(rows, exchange);
        attempts.push({
          stage: '1_EXACT_BROKER_SYMBOL',
          key: `${broker}:${symbol}${exchange ? ` @${exchange}` : ''}`,
          matched: !!row,
          reason: rows.length === 0 ? 'no rows for exact brokerSymbol' : 'matched',
        });
        if (row) return finish(row, '1_EXACT_BROKER_SYMBOL');
      }

      // Stage 2 — normalized broker-symbol variants.
      {
        const rows = await this.prisma.instrumentBroker.findMany({
          where: { broker, brokerSymbol: { in: variants } },
          include: { instrument: true },
        });
        const row = this.pickPreferred(rows, exchange);
        attempts.push({
          stage: '2_NORMALIZED_BROKER_SYMBOL',
          key: `${broker}:[${variants.join(', ')}]`,
          matched: !!row,
          reason: rows.length === 0 ? 'no rows for normalized variants' : 'matched',
        });
        if (row) return finish(row, '2_NORMALIZED_BROKER_SYMBOL');
      }

      // Stage 3 — canonical symbol (instrument underlying / contractKey).
      {
        const rows = await this.prisma.instrumentBroker.findMany({
          where: {
            broker,
            instrument: {
              is: {
                OR: [
                  { underlying: { equals: core, mode: 'insensitive' } },
                  { contractKey: { equals: core, mode: 'insensitive' } },
                ],
              },
            },
          },
          include: { instrument: true },
        });
        const row = this.pickPreferred(rows, exchange);
        attempts.push({
          stage: '3_CANONICAL_SYMBOL',
          key: `${broker}:underlying|contractKey=${core}`,
          matched: !!row,
          reason: rows.length === 0 ? 'no canonical underlying/contractKey match' : 'matched',
        });
        if (row) return finish(row, '3_CANONICAL_SYMBOL');
      }

      // Stage 4 — trading (exchange) symbol.
      {
        const rows = await this.prisma.instrumentBroker.findMany({
          where: {
            broker,
            exchangeSymbol: { in: Array.from(new Set([symbol, core])) },
          },
          include: { instrument: true },
        });
        const row = this.pickPreferred(rows, exchange);
        attempts.push({
          stage: '4_TRADING_SYMBOL',
          key: `${broker}:exchangeSymbol=[${symbol}, ${core}]`,
          matched: !!row,
          reason: rows.length === 0 ? 'no exchangeSymbol match' : 'matched',
        });
        if (row) return finish(row, '4_TRADING_SYMBOL');
      }

      // Stage 5 — instrument token.
      {
        const tokenKey = (token ?? symbol) ?? '';
        if (tokenKey) {
          const rows = await this.prisma.instrumentBroker.findMany({
            where: { broker, brokerToken: tokenKey },
            include: { instrument: true },
          });
          const row = this.pickPreferred(rows, exchange);
          attempts.push({
            stage: '5_INSTRUMENT_TOKEN',
            key: `${broker}:brokerToken=${tokenKey}`,
            matched: !!row,
            reason: rows.length === 0 ? 'no brokerToken match' : 'matched',
          });
          if (row) return finish(row, '5_INSTRUMENT_TOKEN');
        }
      }

      return finish(null, null);
    } catch (err: any) {
      attempts.push({
        stage: 'ERROR',
        key: `${broker}:${symbol}`,
        matched: false,
        reason: err?.message ?? String(err),
      });
      return finish(null, null);
    }
  }

  /**
   * Find the target broker's mapping for a canonical instrument, preferring the
   * source/master exchange so a cross-broker copy lands on the same listing.
   */
  async resolveTarget(
    instrumentId: string,
    broker: Broker,
    exchange?: string | null,
  ): Promise<InstrumentBrokerRow | null> {
    const rows = await this.prisma.instrumentBroker.findMany({
      where: { instrumentId, broker },
      include: { instrument: true },
    });
    return this.pickPreferred(rows, exchange);
  }

  // -------------------------------------------------------------------------
  // Public translation (never throws → structured NOT_FOUND)
  // -------------------------------------------------------------------------

  async translate(req: TranslationRequest): Promise<TranslationResult> {
    const startedAt = Date.now();
    const corr = req.correlationId ? `[${req.correlationId}] ` : '';

    const source = await this.resolveSource(
      req.sourceBroker,
      req.sourceSymbol,
      req.exchange ?? null,
      req.token ?? null,
    );

    if (!source.found || !source.row) {
      const reason = `No ${req.sourceBroker} instrument for symbol "${req.sourceSymbol}"`;
      this.logger.warn(
        `${corr}[InstrumentTranslation] SOURCE_NOT_FOUND ${req.sourceBroker} "${req.sourceSymbol}" ` +
          `normalized="${source.normalizedSymbol}" attempts=` +
          JSON.stringify(source.attempts),
      );
      return {
        found: false,
        stage: 'SOURCE_NOT_FOUND',
        reason,
        incomingSymbol: req.sourceSymbol,
        normalizedSymbol: source.normalizedSymbol,
        attempts: source.attempts,
        lookupDurationMs: Date.now() - startedAt,
      };
    }

    const inst = source.row.instrument;
    const target = await this.resolveTarget(
      inst.id,
      req.targetBroker,
      inst.exchange,
    );

    if (!target) {
      const reason = `No ${req.targetBroker} mapping for instrument "${inst.contractKey}"`;
      this.logger.warn(
        `${corr}[InstrumentTranslation] TARGET_NOT_FOUND source=${req.sourceBroker} ` +
          `"${req.sourceSymbol}" -> ${req.targetBroker} instrument=${inst.contractKey}`,
      );
      return {
        found: false,
        stage: 'TARGET_NOT_FOUND',
        reason,
        incomingSymbol: req.sourceSymbol,
        normalizedSymbol: source.normalizedSymbol,
        attempts: source.attempts,
        lookupDurationMs: Date.now() - startedAt,
      };
    }

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `${corr}[InstrumentTranslation] MATCHED stage=${source.stage} ` +
        `incoming="${req.sourceSymbol}" normalized="${source.normalizedSymbol}" ` +
        `-> ${req.targetBroker} brokerSymbol="${target.brokerSymbol}" ` +
        `tradingSymbol="${target.exchangeSymbol ?? target.brokerSymbol}" ` +
        `token="${target.brokerToken ?? ''}" exchange="${target.exchange}" ` +
        `contractKey="${inst.contractKey}" durationMs=${durationMs}`,
    );

    return {
      found: true,
      matchedStage: source.stage ?? '1_EXACT_BROKER_SYMBOL',

      instrumentId: inst.id,
      contractKey: inst.contractKey,
      underlying: inst.underlying,
      exchange: target.exchange,
      segment: inst.segment,
      exchangeSegment: inst.segment,
      instrumentType: inst.instrumentType,
      expiry: inst.expiry ? inst.expiry.toISOString() : null,
      optionType: inst.optionType ?? null,
      strike: inst.strike ?? null,
      lotSize: inst.lotSize,
      tickSize: inst.tickSize ?? null,

      targetBroker: req.targetBroker,
      targetSymbol: target.brokerSymbol,
      brokerSymbol: target.brokerSymbol,
      tradingSymbol: target.exchangeSymbol ?? target.brokerSymbol,
      token: target.brokerToken ?? null,
      instrumentToken: target.brokerToken ?? null,
      exchangeToken: target.exchangeToken ?? null,

      sourceBroker: req.sourceBroker,
      sourceSymbol: req.sourceSymbol,
      sourceBrokerSymbol: source.row.brokerSymbol,
      lookupDurationMs: durationMs,
    };
  }
}
