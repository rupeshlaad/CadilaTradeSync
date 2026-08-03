import { Broker } from '@prisma/client';

/**
 * Internal lifecycle status of a trade event as it moves through the
 * intake pipeline. This is deliberately narrower than a follower-side
 * "order status" — it only describes what the intake foundation knows
 * about the event, not what happens downstream in the copy-trading
 * pipeline (that is out of scope for Sprint 5.1).
 *
 *  RECEIVED    – raw broker payload landed in the intake service.
 *  NORMALIZED  – shape validated, canonical TradeEvent produced.
 *  VALIDATED   – all pre-execution checks passed (strategy running,
 *                broker session healthy, instrument mapping present, …).
 *  DUPLICATE   – de-duplicated against a recently seen broker event
 *                and intentionally ignored.
 *  REJECTED    – malformed, or one or more validation checks failed.
 */
export enum TradeEventStatus {
  RECEIVED = 'RECEIVED',
  NORMALIZED = 'NORMALIZED',
  VALIDATED = 'VALIDATED',
  DUPLICATE = 'DUPLICATE',
  REJECTED = 'REJECTED',
}

/**
 * Where the trade event originated from. Cadila TradeSync never
 * generates trades — every event describes an execution that already
 * happened on a master account via TradingView / a Python algo / the
 * broker's own terminal / a manual entry.
 */
export enum TradeEventSource {
  ZERODHA_POSTBACK = 'ZERODHA_POSTBACK',
  FYERS_POSTBACK = 'FYERS_POSTBACK',
  BROKER_POLL = 'BROKER_POLL',
  MANUAL_ENTRY = 'MANUAL_ENTRY',
  UNKNOWN = 'UNKNOWN',
}

export type TradeSide = 'BUY' | 'SELL';

/**
 * Raw broker payload as received by whatever listener/poller is feeding
 * the intake pipeline. Field names are intentionally loose so existing
 * broker-specific listeners can call the intake service without needing
 * to translate first — normalization is this pipeline's job.
 *
 * NOTE — `masterAccountId` MUST be our internal TradingAccount.id (i.e.
 * already resolved by the caller). The intake pipeline does not attempt
 * to map broker-side account handles back to platform accounts; that
 * remains the responsibility of the broker listener that already knows
 * which of its subscriptions produced the event.
 */
export interface RawBrokerTrade {
  source: TradeEventSource;
  broker: Broker;
  masterAccountId: string;

  brokerOrderId: string | number | null | undefined;
  brokerExecutionId?: string | number | null;
  brokerSymbol: string | null | undefined;

  side: TradeSide | string | null | undefined;
  quantity: number | string | null | undefined;
  price?: number | string | null;

  brokerTimestamp?: string | number | Date | null;

  /** Original broker payload, retained verbatim for debugging / audit. */
  raw?: unknown;
}

/**
 * Canonical, normalized representation of a single executed master
 * trade. Emitted by the normalization service; consumed by the
 * validation service and by any downstream copy-trading pipeline that
 * later gets built on top of this foundation.
 *
 * Every field is guaranteed populated post-normalization EXCEPT for:
 *   - strategyId / instrumentId / contractKey — best-effort, may be
 *     null if the platform cannot yet resolve them (validation catches
 *     these before allowing further processing).
 */
export interface TradeEvent {
  /** Internally assigned UUID for cross-service correlation / logs. */
  id: string;

  source: TradeEventSource;
  broker: Broker;

  masterAccountId: string;
  strategyId: string | null;

  brokerOrderId: string;
  brokerExecutionId: string | null;
  brokerSymbol: string;

  instrumentId: string | null;
  contractKey: string | null;

  side: TradeSide;
  quantity: number;
  price: number | null;

  status: TradeEventStatus;

  /** ISO-8601 timestamps in UTC. */
  brokerTimestamp: string | null;
  receivedAt: string;

  /** Original broker payload, retained verbatim for debugging / audit. */
  raw: unknown;
}

/**
 * Individual validation check outcome — mirrors the shape used by
 * StrategyExecutionService so operators see a consistent structure
 * across the two pipelines.
 */
export type TradeEventValidationKey =
  | 'shape_valid'
  | 'master_account_exists'
  | 'master_account_connected'
  | 'broker_session_healthy'
  | 'strategy_exists'
  | 'strategy_running'
  | 'instrument_mapping_available'
  | 'not_duplicate';

export interface TradeEventValidationCheck {
  key: TradeEventValidationKey;
  ok: boolean;
  message: string;
}

export interface TradeEventValidationResult {
  ok: boolean;
  checks: TradeEventValidationCheck[];
  errors: TradeEventValidationCheck[];
  validatedAt: string;
}

/**
 * What the intake service records against every event it processes,
 * for the read-only "Trade Event Pipeline" panel in the admin UI.
 */
export interface TradeEventRecord {
  event: TradeEvent;
  validation: TradeEventValidationResult | null;
  /** Set when status = REJECTED and shape/dedupe check produced it. */
  rejectionReason: string | null;
}
