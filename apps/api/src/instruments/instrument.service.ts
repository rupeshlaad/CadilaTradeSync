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

  /**
   * Sprint 5.4.1 — Broker-scoped, relevance-ranked search that powers
   * the Manual Trading autocomplete.
   *
   * Matching (case-insensitive) is performed against:
   *   - InstrumentBroker.brokerSymbol      (broker/trading symbol)
   *   - InstrumentBroker.exchangeSymbol    (exchange-side trading symbol
   *                                          when the importer populated it)
   *   - Instrument.underlying              (company name / underlying)
   *
   * Prisma cannot express "order by relevance" natively, so we fetch a
   * bounded candidate pool via a single index-friendly OR query and
   * rank the rows in memory:
   *
   *   0. Exact brokerSymbol / underlying match
   *   1. brokerSymbol starts-with
   *   2. underlying starts-with
   *   3. brokerSymbol contains / underlying contains
   *
   * The pool is capped at `limit * 4` (or 200, whichever is smaller)
   * so response times stay bounded on the ~200k-row InstrumentBroker
   * table. All the columns we filter on are already indexed either
   * directly (`@@unique([broker, brokerSymbol])`, `underlying` index)
   * or via the parent Instrument row's index set.
   */
  async searchForManualTrading(opts: {
    broker: Broker;
    q: string;
    limit?: number;
  }): Promise<ManualInstrumentSearchRow[]> {
    const raw = (opts.q ?? '').trim();
    if (raw.length < 2) return [];

    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    const poolSize = Math.min(Math.max(limit * 4, limit), 200);

    const where: Prisma.InstrumentBrokerWhereInput = {
      broker: opts.broker,
      OR: [
        { brokerSymbol: { contains: raw, mode: 'insensitive' } },
        { exchangeSymbol: { contains: raw, mode: 'insensitive' } },
        {
          instrument: {
            is: { underlying: { contains: raw, mode: 'insensitive' } },
          },
        },
      ],
    };

    const rows = await this.prisma.instrumentBroker.findMany({
      where,
      include: { instrument: true },
      orderBy: [{ brokerSymbol: 'asc' }],
      take: poolSize,
    });

    const needle = raw.toLowerCase();
    const ranked = rows
      .map((r) => ({ row: r, rank: rankInstrumentMatch(needle, r) }))
      .filter((r) => r.rank < RANK_NO_MATCH)
      .sort((a, b) => {
        if (a.rank !== b.rank) return a.rank - b.rank;
        // Tie-breaker: prefer shorter broker symbols (INFY before INFYnnDECFUT)
        const la = a.row.brokerSymbol.length;
        const lb = b.row.brokerSymbol.length;
        if (la !== lb) return la - lb;
        return a.row.brokerSymbol.localeCompare(b.row.brokerSymbol);
      })
      .slice(0, limit);

    return ranked.map(({ row }) => ({
      instrumentId: row.instrument.id,
      tradingSymbol: row.brokerSymbol,
      brokerSymbol: row.brokerSymbol,
      displayName: buildInstrumentDisplayName(row.instrument),
      exchange: row.instrument.exchange,
      segment: row.instrument.segment,
      lotSize: row.instrument.lotSize,
      tickSize: row.instrument.tickSize,
      expiry: row.instrument.expiry
        ? row.instrument.expiry.toISOString()
        : null,
      strike: row.instrument.strike,
      optionType: row.instrument.optionType,
    }));
  }
}

// ---------------------------------------------------------------------------
// Sprint 5.4.1 — Manual Trading search result shape
// ---------------------------------------------------------------------------

/**
 * A single result row returned from
 * `InstrumentService.searchForManualTrading`. Field names match the
 * sprint spec so the admin UI can consume them without translation.
 */
export interface ManualInstrumentSearchRow {
  instrumentId: string;
  tradingSymbol: string;
  brokerSymbol: string;
  displayName: string;
  exchange: string;
  segment: string;
  lotSize: number;
  tickSize: number | null;
  expiry: string | null;
  strike: number | null;
  optionType: string | null;
}

const RANK_EXACT = 0;
const RANK_BROKER_PREFIX = 1;
const RANK_UNDERLYING_PREFIX = 2;
const RANK_CONTAINS = 3;
const RANK_NO_MATCH = 999;

function rankInstrumentMatch(
  needle: string,
  row: { brokerSymbol: string; exchangeSymbol: string | null; instrument: { underlying: string } },
): number {
  const brokerSym = row.brokerSymbol.toLowerCase();
  const exchangeSym = (row.exchangeSymbol ?? '').toLowerCase();
  const underlying = row.instrument.underlying.toLowerCase();

  if (brokerSym === needle || underlying === needle || exchangeSym === needle) {
    return RANK_EXACT;
  }
  if (brokerSym.startsWith(needle) || exchangeSym.startsWith(needle)) {
    return RANK_BROKER_PREFIX;
  }
  if (underlying.startsWith(needle)) {
    return RANK_UNDERLYING_PREFIX;
  }
  if (
    brokerSym.includes(needle) ||
    exchangeSym.includes(needle) ||
    underlying.includes(needle)
  ) {
    return RANK_CONTAINS;
  }
  return RANK_NO_MATCH;
}

/**
 * Human-friendly one-line description of a canonical Instrument row.
 * The importer stores everything we need — this just composes it.
 *
 *   Cash equity   →  "INFY"
 *   Future        →  "NIFTY 25-DEC-2025 FUT"
 *   Option        →  "NIFTY 25-DEC-2025 24000 CE"
 */
function buildInstrumentDisplayName(inst: {
  underlying: string;
  instrumentType: string;
  expiry: Date | null;
  strike: number | null;
  optionType: string | null;
}): string {
  const parts: string[] = [inst.underlying];
  if (inst.expiry) {
    parts.push(formatInstrumentExpiry(inst.expiry));
  }
  if (inst.optionType && inst.strike !== null && inst.strike !== undefined) {
    parts.push(String(inst.strike));
    parts.push(inst.optionType);
  } else if (
    inst.instrumentType &&
    inst.instrumentType.toUpperCase() === 'FUT'
  ) {
    parts.push('FUT');
  }
  return parts.join(' ');
}

function formatInstrumentExpiry(expiry: Date): string {
  const months = [
    'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
    'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
  ];
  const dd = String(expiry.getUTCDate()).padStart(2, '0');
  const mmm = months[expiry.getUTCMonth()];
  const yyyy = expiry.getUTCFullYear();
  return `${dd}-${mmm}-${yyyy}`;
}
