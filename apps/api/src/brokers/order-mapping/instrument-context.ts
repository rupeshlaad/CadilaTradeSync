/**
 * Sprint 6.2.8 — Broker-neutral resolved-instrument facts.
 *
 * A single, minimal, broker-agnostic view of an instrument, resolved from the
 * canonical `Instrument` row (via `InstrumentBroker`). It carries exactly the
 * fields a broker order-mapper needs to build a segment-correct payload
 * (product type, right / strike / expiry for derivatives) without re-querying
 * the database or leaking Prisma types into the mappers.
 *
 * This is the ONE shape every order mapper consumes — there is no
 * broker-specific instrument context anywhere else in the codebase.
 */
export interface ResolvedInstrument {
  contractKey: string;
  /** CTS canonical exchange (NSE / BSE / NFO / BFO / CDS / MCX …). */
  exchange: string;
  /** CTS canonical segment (NSE / BSE / NFO / BFO / CDS / MCX …). */
  segment: string;
  /** EQ / FUT / CE / PE (as persisted by the importers). */
  instrumentType: string;
  /** CE / PE for options, null otherwise. */
  optionType: string | null;
  /** Option strike, null for cash / futures. */
  strike: number | null;
  /** ISO-8601 expiry for derivatives, null for cash. */
  expiry: string | null;
  underlying: string;
}

/** Coarse instrument class used to pick a broker product type. */
export type InstrumentClass = 'EQUITY_CASH' | 'FUTURE' | 'OPTION';

/**
 * Classify a resolved instrument into cash / future / option. Derivatives are
 * identified by an explicit option type (CE/PE), a FUT instrument type, or the
 * presence of an expiry on a derivative segment. Everything else is cash.
 */
export function classifyResolvedInstrument(
  instrument?: ResolvedInstrument | null,
): InstrumentClass {
  if (!instrument) return 'EQUITY_CASH';
  const opt = (instrument.optionType ?? '').toUpperCase().trim();
  if (opt === 'CE' || opt === 'PE') return 'OPTION';

  const type = (instrument.instrumentType ?? '').toUpperCase().trim();
  if (type === 'FUT') return 'FUTURE';

  const segment = (instrument.segment ?? '').toUpperCase().trim();
  const exchange = (instrument.exchange ?? '').toUpperCase().trim();
  const derivativeSegment =
    segment.includes('FO') ||
    segment.includes('FUT') ||
    segment.includes('OPT') ||
    segment === 'CDS' ||
    segment === 'BCD' ||
    segment === 'MCX' ||
    exchange === 'NFO' ||
    exchange === 'BFO' ||
    exchange === 'CDS' ||
    exchange === 'MCX';
  if (derivativeSegment && instrument.expiry) return 'FUTURE';

  return 'EQUITY_CASH';
}
