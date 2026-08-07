import { Injectable, NotFoundException } from '@nestjs/common';
import { Broker, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

/**
 * Deterministic exchange preference when a caller does not pin an exchange.
 * NSE is the primary listing for most Indian equities, BSE the secondary;
 * anything else falls through in insertion order. Sprint 6.2.8.
 */
const EXCHANGE_PREFERENCE = ['NSE', 'BSE', 'NFO', 'BFO', 'CDS', 'MCX'];

function pickPreferredExchange<T extends { exchange: string | null }>(
  rows: T[],
  exchange?: string | null,
): T | null {
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

@Injectable()
export class InstrumentResolverService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve a broker symbol to its InstrumentBroker mapping (+ canonical
   * Instrument). A broker symbol is not unique across exchanges (TCS is on
   * NSE and BSE), so an optional `exchange` pins the listing; otherwise the
   * NSE > BSE > … preference decides deterministically. Sprint 6.2.8.
   */
  async resolveByBrokerSymbol(
    broker: Broker,
    brokerSymbol: string,
    exchange?: string | null,
  ) {
    const where: Prisma.InstrumentBrokerWhereInput = { broker, brokerSymbol };
    if (exchange) where.exchange = exchange;
    const rows = await this.prisma.instrumentBroker.findMany({
      where,
      include: { instrument: true },
    });
    return pickPreferredExchange(rows, exchange);
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
    const rows = await this.prisma.instrumentBroker.findMany({
      where: { instrumentId, broker },
    });
    return pickPreferredExchange(rows, exchange);
  }

  /**
   * Translate a broker-specific symbol from one broker to another via the
   * canonical Instrument row (contractKey is the join key). This is the
   * core building block for multi-broker copy trading: given a fill on
   * the master's broker, work out the exact symbol the child broker
   * needs to place an equivalent order.
   *
   * Throws NotFoundException when either side of the mapping is missing
   * (unknown source symbol, or the target broker has no mapping for
   * that instrument yet — e.g. importer hasn't run for that broker).
   */
  async translate(
    fromBroker: Broker,
    fromSymbol: string,
    toBroker: Broker,
    exchange?: string | null,
  ) {
    const source = await this.resolveByBrokerSymbol(
      fromBroker,
      fromSymbol,
      exchange,
    );
    if (!source) {
      throw new NotFoundException(
        `Instrument not found for ${fromBroker} symbol "${fromSymbol}"`,
      );
    }

    if (fromBroker === toBroker) {
      return {
        instrument: source.instrument,
        source: {
          broker: source.broker,
          brokerSymbol: source.brokerSymbol,
          brokerToken: source.brokerToken,
        },
        target: {
          broker: source.broker,
          brokerSymbol: source.brokerSymbol,
          brokerToken: source.brokerToken,
        },
      };
    }

    const target = await this.getBrokerSymbol(
      source.instrumentId,
      toBroker,
      source.instrument.exchange,
    );
    if (!target) {
      throw new NotFoundException(
        `No ${toBroker} mapping for instrument "${source.instrument.contractKey}"`,
      );
    }

    return {
      instrument: source.instrument,
      source: {
        broker: source.broker,
        brokerSymbol: source.brokerSymbol,
        brokerToken: source.brokerToken,
      },
      target: {
        broker: target.broker,
        brokerSymbol: target.brokerSymbol,
        brokerToken: target.brokerToken,
      },
    };
  }
}
