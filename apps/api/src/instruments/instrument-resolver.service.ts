import { Injectable, NotFoundException } from '@nestjs/common';
import { Broker } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';
import { InstrumentTranslationService } from './instrument-translation.service';

/**
 * Thin compatibility facade over the canonical InstrumentTranslationService.
 *
 * Sprint — the single instrument lookup path. All resolver methods now DELEGATE
 * to InstrumentTranslationService so there is exactly one normalization +
 * deterministic-lookup implementation shared by every caller (Translation UI,
 * CopyTrading, manual-trade validator, order-actions). No duplicate resolver
 * lookup logic remains here; the public method signatures are preserved so
 * existing callers are unaffected.
 */
@Injectable()
export class InstrumentResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly translation: InstrumentTranslationService,
  ) {}

  /**
   * Resolve a broker symbol to its InstrumentBroker mapping (+ canonical
   * Instrument) via the canonical deterministic lookup. Exchange is a
   * preference, not a hard filter. Returns null when unresolved.
   */
  async resolveByBrokerSymbol(
    broker: Broker,
    brokerSymbol: string,
    exchange?: string | null,
  ) {
    const res = await this.translation.resolveSource(
      broker,
      brokerSymbol,
      exchange ?? null,
    );
    return res.row;
  }

  async resolveByContractKey(contractKey: string) {
    return this.prisma.instrument.findUnique({
      where: {
        contractKey,
      },
      include: {
        brokers: true,
      },
    });
  }

  /**
   * Find the target broker's mapping for a canonical instrument, preferring
   * the master's exchange so a cross-broker copy lands on the same listing.
   */
  async getBrokerSymbol(
    instrumentId: string,
    broker: Broker,
    exchange?: string | null,
  ) {
    return this.translation.resolveTarget(instrumentId, broker, exchange ?? null);
  }

  /**
   * Translate a broker-specific symbol from one broker to another via the
   * canonical Instrument row. Delegates entirely to the canonical
   * InstrumentTranslationService (same code path the copy engine uses) and
   * reshapes the result into the { instrument, source, target } contract the
   * admin Translation UI endpoint already consumes.
   *
   * Throws NotFoundException when either side is unresolved (unchanged public
   * behaviour for the admin endpoint).
   */
  async translate(
    fromBroker: Broker,
    fromSymbol: string,
    toBroker: Broker,
    exchange?: string | null,
  ) {
    const source = await this.translation.resolveSource(
      fromBroker,
      fromSymbol,
      exchange ?? null,
    );
    if (!source.found || !source.row) {
      throw new NotFoundException(
        `Instrument not found for ${fromBroker} symbol "${fromSymbol}"`,
      );
    }

    const src = source.row;

    if (fromBroker === toBroker) {
      return {
        instrument: src.instrument,
        source: {
          broker: src.broker,
          brokerSymbol: src.brokerSymbol,
          brokerToken: src.brokerToken,
        },
        target: {
          broker: src.broker,
          brokerSymbol: src.brokerSymbol,
          brokerToken: src.brokerToken,
        },
      };
    }

    const target = await this.translation.resolveTarget(
      src.instrumentId,
      toBroker,
      src.instrument.exchange,
    );
    if (!target) {
      throw new NotFoundException(
        `No ${toBroker} mapping for instrument "${src.instrument.contractKey}"`,
      );
    }

    return {
      instrument: src.instrument,
      source: {
        broker: src.broker,
        brokerSymbol: src.brokerSymbol,
        brokerToken: src.brokerToken,
      },
      target: {
        broker: target.broker,
        brokerSymbol: target.brokerSymbol,
        brokerToken: target.brokerToken,
      },
    };
  }
}
