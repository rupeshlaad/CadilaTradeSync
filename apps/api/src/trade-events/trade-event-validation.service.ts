import { Injectable, Logger } from '@nestjs/common';
import { ConnectionStatus } from '@prisma/client';

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

  async validate(event: TradeEvent): Promise<TradeEventValidationResult> {
    const checks: TradeEventValidationCheck[] = [];

    // 1) Master account exists
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

    // 2) Master account connected — enabled + accountType MASTER + broker match
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

    // 3) Broker session healthy
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

    // 4) Strategy exists (resolved during normalization)
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

    // 5) Strategy RUNNING — resolved via the in-memory execution engine.
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

    // 6) Instrument mapping available
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
