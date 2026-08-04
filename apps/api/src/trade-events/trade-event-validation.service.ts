import { Injectable, Logger } from '@nestjs/common';
import { Broker, ConnectionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';
import { BrokerService } from '../brokers/broker.service';
import { StrategyExecutionService } from '../strategy-execution/strategy-execution.service';
import { ExecutionState } from '../strategy-execution/execution-state';

import {
  TradeEvent,
  TradeEventValidationCheck,
  TradeEventValidationResult,
} from './trade-event';

/**
 * Brokers that CTS currently supports as MASTER accounts. Kept in sync
 * with the broker adapters wired into AppModule (ZERODHA, FYERS,
 * SHOONYA). Extending this list is a broker-integration concern and is
 * intentionally decoupled from the Broker Prisma enum which also
 * carries brokers that only exist as future placeholders.
 */
export const SUPPORTED_MASTER_BROKERS: ReadonlySet<Broker> = new Set([
  Broker.ZERODHA,
  Broker.FYERS,
  Broker.SHOONYA,
]);

/**
 * Broker-side terminal statuses that indicate an actually-executed
 * trade. Everything else (OPEN, TRIGGER_PENDING, CANCELLED, REJECTED,
 * PARTIAL_FILLED, ...) is not eligible for downstream copy execution
 * from the perspective of this foundation.
 *
 * Comparison is case-insensitive. Numeric statuses from Fyers (e.g.
 * "2" = Filled) are also accepted.
 */
export const SUPPORTED_TRADE_STATUSES: ReadonlySet<string> = new Set([
  'COMPLETE',
  'COMPLETED',
  'FILLED',
  'EXECUTED',
  'TRADED',
  '2', // Fyers: filled
]);

export interface TradeEventValidationOptions {
  /**
   * Hint from the intake pipeline: was this event a duplicate of a
   * recently-seen (broker, orderId, executionId) triple? Surfaced as
   * the `not_duplicate` validation check so the admin monitor renders
   * a consistent structured result even for de-duplicated events.
   */
  wasDuplicate?: boolean;
}

/**
 * Runs the pre-execution checks that gate whether a normalized
 * TradeEvent is allowed to enter the downstream copy-trading pipeline.
 *
 * Reuses the health signal exposed by BrokerService.getSessionHealth
 * and the execution state maintained by StrategyExecutionService so
 * there is a single source of truth for both signals.
 */
@Injectable()
export class TradeEventValidationService {
  private readonly logger = new Logger('TradeEventValidation');

  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerService: BrokerService,
    private readonly execution: StrategyExecutionService,
  ) {}

  async validate(
    event: TradeEvent,
    opts: TradeEventValidationOptions = {},
  ): Promise<TradeEventValidationResult> {
    const checks: TradeEventValidationCheck[] = [];

    // 1) Mandatory fields present. Normalization already rejects most
    //    shape errors, but surfacing this explicitly gives the admin
    //    UI a stable slot in the pipeline view and defends against a
    //    caller that constructs a TradeEvent directly (e.g. a future
    //    manual entry path) instead of going through normalization.
    const missing: string[] = [];
    if (!event.masterAccountId) missing.push('masterAccountId');
    if (!event.brokerOrderId) missing.push('brokerOrderId');
    if (!event.brokerSymbol) missing.push('brokerSymbol');
    if (!event.side) missing.push('side');
    if (!(event.quantity > 0)) missing.push('quantity');
    checks.push({
      key: 'mandatory_fields_present',
      ok: missing.length === 0,
      message:
        missing.length === 0
          ? 'All mandatory trade fields are present'
          : `Missing mandatory field(s): ${missing.join(', ')}`,
    });

    // 2) Supported broker. Rejects events for brokers that have no
    //    adapter wired into CTS yet, before we start hitting Prisma /
    //    session health for a broker we can't act on downstream.
    const brokerSupported = SUPPORTED_MASTER_BROKERS.has(event.broker);
    checks.push({
      key: 'supported_broker',
      ok: brokerSupported,
      message: brokerSupported
        ? `Broker ${event.broker} is supported as a master`
        : `Broker ${event.broker} is not supported as a master (no adapter wired)`,
    });

    // 3) Supported trade status. Optional — if the source listener did
    //    not forward a status the check is a no-op pass, preserving
    //    backward compatibility with existing broker integrations that
    //    already pre-filter to COMPLETE before calling into the intake
    //    service (see MasterWatcherService).
    if (event.rawStatus === null) {
      checks.push({
        key: 'supported_trade_status',
        ok: true,
        message: 'No broker-side status forwarded — check skipped',
      });
    } else {
      const statusOk = SUPPORTED_TRADE_STATUSES.has(
        event.rawStatus.toUpperCase(),
      );
      checks.push({
        key: 'supported_trade_status',
        ok: statusOk,
        message: statusOk
          ? `Broker-side status "${event.rawStatus}" is a supported terminal status`
          : `Broker-side status "${event.rawStatus}" is not a supported terminal status`,
      });
    }

    // 4) Master account exists
    const account = await this.prisma.tradingAccount.findUnique({
      where: { id: event.masterAccountId },
    });
    checks.push({
      key: 'master_account_exists',
      ok: !!account,
      message: account
        ? `Master account ${account.nickname} found`
        : `Master account ${event.masterAccountId} not found`,
    });

    // 5) Master account connected — enabled + accountType MASTER + broker match
    if (account) {
      const connected =
        account.enabled === true &&
        account.accountType === 'MASTER' &&
        account.broker === event.broker;
      checks.push({
        key: 'master_account_connected',
        ok: connected,
        message: connected
          ? `Master account is enabled and connected via ${account.broker}`
          : `Master account not eligible (enabled=${account.enabled}, type=${account.accountType}, broker=${account.broker} vs event.broker=${event.broker})`,
      });
    } else {
      checks.push({
        key: 'master_account_connected',
        ok: false,
        message: 'Skipped — master account missing',
      });
    }

    // 6) Broker session healthy
    if (account) {
      try {
        const health = await this.brokerService.getSessionHealth(account.id);
        const healthy =
          !!health.loginTime &&
          health.connectionStatus === ConnectionStatus.CONNECTED &&
          health.sessionActive === true &&
          health.tokenExpired !== true;
        checks.push({
          key: 'broker_session_healthy',
          ok: healthy,
          message: healthy
            ? 'Broker session CONNECTED and token valid'
            : `Broker session unhealthy (status=${health.connectionStatus}, tokenExpired=${health.tokenExpired}, active=${health.sessionActive})`,
        });
      } catch (err: any) {
        checks.push({
          key: 'broker_session_healthy',
          ok: false,
          message:
            err?.message ?? 'Failed to read broker session for master account',
        });
      }
    } else {
      checks.push({
        key: 'broker_session_healthy',
        ok: false,
        message: 'Skipped — master account missing',
      });
    }

    // 7) Strategy exists (resolved during normalization)
    let strategyRow: { id: string; enabled: boolean; status: string } | null = null;
    if (event.strategyId) {
      strategyRow = await this.prisma.strategy.findUnique({
        where: { id: event.strategyId },
        select: { id: true, enabled: true, status: true },
      });
    }
    checks.push({
      key: 'strategy_exists',
      ok: !!strategyRow,
      message: strategyRow
        ? `Strategy ${strategyRow.id} found`
        : event.strategyId
        ? `Strategy ${event.strategyId} referenced by event was not found`
        : 'No strategy is linked to the master account for this trade',
    });

    // 8) Strategy RUNNING — resolved via the in-memory execution engine.
    //    A strategy is "running" for the purposes of accepting trade events
    //    only when the execution state machine says RUNNING. PAUSED /
    //    READY / STOPPED / ERROR all fail this check by design — the
    //    downstream copy-trading pipeline must not act on events for
    //    strategies that aren't actively executing.
    if (strategyRow) {
      const state = this.execution.getExecutionStatus(strategyRow.id).state;
      const running = state === ExecutionState.RUNNING;
      checks.push({
        key: 'strategy_running',
        ok: running,
        message: running
          ? 'Strategy execution state is RUNNING'
          : `Strategy execution state is ${state} (not RUNNING)`,
      });
    } else {
      checks.push({
        key: 'strategy_running',
        ok: false,
        message: 'Skipped — strategy could not be resolved',
      });
    }

    // 9) Instrument mapping available
    //    Normalization already attempts to attach instrumentId; if it
    //    is null, either the broker's universe hasn't been imported or
    //    the symbol simply doesn't exist. Either way the pipeline
    //    cannot fan out to followers without a canonical instrument.
    const mappingOk = !!event.instrumentId;
    checks.push({
      key: 'instrument_mapping_available',
      ok: mappingOk,
      message: mappingOk
        ? `Instrument mapping resolved (${event.contractKey ?? event.instrumentId})`
        : `No InstrumentBroker mapping for ${event.broker} ${event.brokerSymbol}`,
    });

    // 10) Duplicate detection. The intake service dedupes on
    //     (broker, orderId, executionId) and passes the outcome in via
    //     opts.wasDuplicate so this check reflects the pipeline-level
    //     decision without validation itself keeping state.
    const notDup = !opts.wasDuplicate;
    checks.push({
      key: 'not_duplicate',
      ok: notDup,
      message: notDup
        ? 'Event is not a duplicate of a recently seen broker event'
        : 'Duplicate of a recently seen (broker, orderId, executionId) event',
    });

    const errors = checks.filter((c) => !c.ok);
    if (errors.length > 0) {
      this.logger.warn(
        `TradeEvent ${event.id} validation failed: ${errors
          .map((e) => e.key)
          .join(', ')}`,
      );
    }

    return {
      ok: errors.length === 0,
      checks,
      errors,
      validatedAt: new Date().toISOString(),
    };
  }
}
