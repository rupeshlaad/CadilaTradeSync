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
   * Sprint 5.4.4 refined the ranking to the 9-tier order laid out in
   * the spec, with a family-based secondary sort so results group
   * naturally as Index → Equity → Future → Call → Put and a strike
   * proximity tiebreaker for all-digit numeric queries (e.g. `26000`
   * returns the closest strikes first).
   *
   * Ranking tiers (lower = better):
   *   1. Underlying exact match
   *   2. Underlying starts-with
   *   3. ExchangeSymbol starts-with
   *   4. BrokerSymbol starts-with
   *   5. DisplayName starts-with
   *   6. Underlying contains
   *   7. ExchangeSymbol contains
   *   8. BrokerSymbol contains
   *   9. DisplayName contains
   *
   * Matching (case-insensitive) is performed against:
   *   - Instrument.underlying              (company name / underlying)
   *   - InstrumentBroker.exchangeSymbol    (exchange-side trading symbol
   *                                          when the importer populated it)
   *   - InstrumentBroker.brokerSymbol      (broker/trading symbol)
   *   - Computed displayName               (composed on the fly)
   *
   * Prisma cannot express "order by relevance" natively, so we fetch
   * a bounded candidate pool via a single index-friendly OR query and
   * rank the rows in memory. The DB-level OR filter still uses only
   * the three real columns; the displayName tier is applied purely at
   * ranking time (its constituent parts already flow through the
   * underlying / brokerSymbol OR clauses so no rows are missed).
   *
   * The pool cap of 500 keeps response times bounded on the ~200k-row
   * InstrumentBroker table while giving the ranker enough headroom on
   * high-fanout queries (e.g. every NIFTY option chain).
   */
  async searchForManualTrading(opts: {
    broker: Broker;
    q: string;
    limit?: number;
  }): Promise<ManualInstrumentSearchRow[]> {
    const raw = (opts.q ?? '').trim();
    if (raw.length < 2) return [];

    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
    // Sprint 5.4.4 — wider pool so relevance ranking has enough
    // headroom on high-fanout queries (option chains).
    const poolSize = Math.min(Math.max(limit * 10, 100), 500);

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
    const numericNeedle = /^\d+$/.test(raw) ? Number(raw) : null;

    // Compute displayName once per candidate so both the ranker and
    // the response projection reuse the same string.
    const enriched = rows.map((row) => {
      const displayName = buildInstrumentDisplayName(row.instrument);
      return {
        row,
        displayName,
        rank: rankInstrumentMatch(needle, row, displayName),
        family: classifyInstrumentFamily(row.instrument),
      };
    });

    const ranked = enriched
      .filter((r) => r.rank < RANK_NO_MATCH)
      .sort((a, b) => {
        // 1) Primary: relevance rank.
        if (a.rank !== b.rank) return a.rank - b.rank;
        // 2) Secondary: family (Index → Equity → Future → CE → PE → other).
        if (a.family !== b.family) return a.family - b.family;
        // 3) Numeric queries: prefer strikes closest to the query.
        if (numericNeedle !== null) {
          const ds = strikeDistance(a.row.instrument.strike, numericNeedle);
          const db = strikeDistance(b.row.instrument.strike, numericNeedle);
          if (ds !== db) return ds - db;
        }
        // 4) Earliest expiry first (nulls / cash last).
        const ea = a.row.instrument.expiry
          ? a.row.instrument.expiry.getTime()
          : Number.POSITIVE_INFINITY;
        const eb = b.row.instrument.expiry
          ? b.row.instrument.expiry.getTime()
          : Number.POSITIVE_INFINITY;
        if (ea !== eb) return ea - eb;
        // 5) Strike ascending inside the same expiry.
        const sa = a.row.instrument.strike ?? Number.POSITIVE_INFINITY;
        const sb = b.row.instrument.strike ?? Number.POSITIVE_INFINITY;
        if (sa !== sb) return sa - sb;
        // 6) Prefer shorter broker symbols (INFY before INFY26DECFUT).
        const la = a.row.brokerSymbol.length;
        const lb = b.row.brokerSymbol.length;
        if (la !== lb) return la - lb;
        return a.row.brokerSymbol.localeCompare(b.row.brokerSymbol);
      })
      .slice(0, limit);

    return ranked.map(({ row, displayName }) => ({
      instrumentId: row.instrument.id,
      tradingSymbol: row.brokerSymbol,
      brokerSymbol: row.brokerSymbol,
      displayName,
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

// ---------------------------------------------------------------------------
// Sprint 5.4.4 — Ranking helpers
// ---------------------------------------------------------------------------

/**
 * 9-tier relevance rank per the sprint spec. Lower is better; rows
 * that don't match at all return RANK_NO_MATCH and are filtered out.
 *
 *   1. Underlying exact
 *   2. Underlying starts-with
 *   3. ExchangeSymbol starts-with
 *   4. BrokerSymbol starts-with
 *   5. DisplayName starts-with
 *   6. Underlying contains
 *   7. ExchangeSymbol contains
 *   8. BrokerSymbol contains
 *   9. DisplayName contains
 *
 * The exact tiers are intentionally strict — an exact underlying
 * match on "NIFTY" guarantees NIFTY rows outrank BANKNIFTY,
 * FINNIFTY, MIDCPNIFTY (which are only "underlying contains").
 */
const RANK_UNDERLYING_EXACT = 1;
const RANK_UNDERLYING_PREFIX = 2;
const RANK_EXCHANGE_SYMBOL_PREFIX = 3;
const RANK_BROKER_SYMBOL_PREFIX = 4;
const RANK_DISPLAY_NAME_PREFIX = 5;
const RANK_UNDERLYING_CONTAINS = 6;
const RANK_EXCHANGE_SYMBOL_CONTAINS = 7;
const RANK_BROKER_SYMBOL_CONTAINS = 8;
const RANK_DISPLAY_NAME_CONTAINS = 9;
const RANK_NO_MATCH = 999;

function rankInstrumentMatch(
  needle: string,
  row: {
    brokerSymbol: string;
    exchangeSymbol: string | null;
    instrument: { underlying: string };
  },
  displayName: string,
): number {
  const brokerSym = row.brokerSymbol.toLowerCase();
  const exchangeSym = (row.exchangeSymbol ?? '').toLowerCase();
  const underlying = row.instrument.underlying.toLowerCase();
  const display = displayName.toLowerCase();

  if (underlying === needle) return RANK_UNDERLYING_EXACT;
  if (underlying.startsWith(needle)) return RANK_UNDERLYING_PREFIX;
  if (exchangeSym && exchangeSym.startsWith(needle))
    return RANK_EXCHANGE_SYMBOL_PREFIX;
  if (brokerSym.startsWith(needle)) return RANK_BROKER_SYMBOL_PREFIX;
  if (display.startsWith(needle)) return RANK_DISPLAY_NAME_PREFIX;
  if (underlying.includes(needle)) return RANK_UNDERLYING_CONTAINS;
  if (exchangeSym && exchangeSym.includes(needle))
    return RANK_EXCHANGE_SYMBOL_CONTAINS;
  if (brokerSym.includes(needle)) return RANK_BROKER_SYMBOL_CONTAINS;
  if (display.includes(needle)) return RANK_DISPLAY_NAME_CONTAINS;
  return RANK_NO_MATCH;
}

/**
 * Family ordering for secondary sort. Lower value = shown first.
 *
 *   Index    → 0   (spot index, if listed)
 *   Equity   → 1   (cash equity — 'RELIANCE EQ' before its derivatives)
 *   Future   → 2
 *   Call     → 3   (options: CE)
 *   Put      → 4   (options: PE)
 *   Other    → 5   (anything unrecognised)
 *
 * The Equity tier sits between Index and Future so that a query like
 * "RELIANCE" surfaces the deliverable EQ row before its futures /
 * options chain (both share `underlying = "RELIANCE"`).
 */
const FAMILY_INDEX = 0;
const FAMILY_EQUITY = 1;
const FAMILY_FUTURE = 2;
const FAMILY_CALL = 3;
const FAMILY_PUT = 4;
const FAMILY_OTHER = 5;

function classifyInstrumentFamily(inst: {
  instrumentType: string;
  optionType: string | null;
  strike: number | null;
  expiry: Date | null;
  segment: string;
  exchange: string;
}): number {
  const type = (inst.instrumentType ?? '').toUpperCase().trim();
  const opt = (inst.optionType ?? '').toUpperCase().trim();
  const segment = (inst.segment ?? '').toUpperCase().trim();

  if (opt === 'CE') return FAMILY_CALL;
  if (opt === 'PE') return FAMILY_PUT;
  if (type === 'FUT') return FAMILY_FUTURE;
  if (type === 'EQ') return FAMILY_EQUITY;
  if (type === 'INDEX' || segment === 'INDICES' || segment === 'INDEX')
    return FAMILY_INDEX;
  // Bare underlying (no expiry / strike / option) on a cash segment
  // is treated as equity — some importers omit the explicit EQ type.
  if (!inst.expiry && inst.strike === null && !opt) {
    return FAMILY_EQUITY;
  }
  return FAMILY_OTHER;
}

/**
 * Absolute distance between the row's strike and a numeric query
 * (e.g. `26000`). Rows without a strike are pushed to the end.
 */
function strikeDistance(strike: number | null, needle: number): number {
  if (strike === null || strike === undefined) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(strike - needle);
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
