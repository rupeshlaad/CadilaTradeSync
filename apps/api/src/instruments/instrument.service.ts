import { Injectable } from '@nestjs/common';
import { Broker, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.module';

export interface InstrumentSearchOptions {
  q: string;
  broker?: Broker;
  exchange?: string;
  segment?: string;
  instrumentType?: string;
  limit?: number;
}

@Injectable()
export class InstrumentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Exact broker-symbol lookup. Retained from Sprint 1 so existing callers
   * (import service, resolver) keep working.
   */
  async findByBrokerSymbol(broker: Broker, brokerSymbol: string) {
    return this.prisma.instrumentBroker.findUnique({
      where: {
        broker_brokerSymbol: {
          broker,
          brokerSymbol,
        },
      },
      include: {
        instrument: true,
      },
    });
  }

  /**
   * Given a contractKey and a target broker, find the target broker's mapping
   * for that instrument. Used by the resolver's cross-broker translation.
   */
  async findTargetBrokerSymbol(targetBroker: Broker, contractKey: string) {
    return this.prisma.instrumentBroker.findFirst({
      where: {
        broker: targetBroker,
        instrument: {
          contractKey,
        },
      },
      include: {
        instrument: true,
      },
    });
  }

  /**
   * Look up an instrument by its canonical contractKey along with every
   * broker mapping we have for it.
   */
  async getByContractKey(contractKey: string) {
    return this.prisma.instrument.findUnique({
      where: { contractKey },
      include: { brokers: true },
    });
  }

  /**
   * Return every broker mapping for a given instrument id.
   */
  async listBrokerSymbolsForInstrument(instrumentId: string) {
    return this.prisma.instrumentBroker.findMany({
      where: { instrumentId },
    });
  }

  /**
   * Free-text search across the InstrumentBroker join table so we can return
   * the exact broker symbol that will be used to place orders, alongside the
   * underlying canonical Instrument row for context.
   *
   * Matching rules (case-insensitive):
   *  - brokerSymbol startsWith(query)   — index-friendly, high signal for
   *                                        broker / trading symbol prefixes.
   *  - underlying   contains(query)     — captures company-name searches
   *                                        ("Reliance Industries") and mid-
   *                                        string matches for options/futures.
   *
   * Optional filters (broker, exchange, segment, instrumentType) narrow the
   * result set further. Results are capped at `limit` (default 25, max 100).
   */
  async search(opts: InstrumentSearchOptions) {
    const raw = (opts.q ?? '').trim();
    if (!raw) return [];

    const q = raw;
    const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);

    const instrumentFilter: Prisma.InstrumentWhereInput = {};
    if (opts.exchange) instrumentFilter.exchange = opts.exchange;
    if (opts.segment) instrumentFilter.segment = opts.segment;
    if (opts.instrumentType) instrumentFilter.instrumentType = opts.instrumentType;

    const where: Prisma.InstrumentBrokerWhereInput = {
      ...(opts.broker ? { broker: opts.broker } : {}),
      ...(Object.keys(instrumentFilter).length > 0
        ? { instrument: { is: instrumentFilter } }
        : {}),
      OR: [
        { brokerSymbol: { startsWith: q, mode: 'insensitive' } },
        {
          instrument: {
            is: { underlying: { contains: q, mode: 'insensitive' } },
          },
        },
      ],
    };

    return this.prisma.instrumentBroker.findMany({
      where,
      include: { instrument: true },
      orderBy: [{ brokerSymbol: 'asc' }],
      take: limit,
    });
  }
}
