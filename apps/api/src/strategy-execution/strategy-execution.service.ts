import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Broker, ConnectionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';
import { BrokerService } from '../brokers/broker.service';
import { ExecutionContext } from './execution-context';
import {
  ExecutionState,
  isTransitionAllowed,
} from './execution-state';

export interface ValidationCheck {
  key:
    | 'strategy_exists'
    | 'strategy_active'
    | 'master_account_exists'
    | 'broker_session_exists'
    | 'broker_session_healthy'
    | 'instrument_mappings_valid';
  ok: boolean;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  strategyId: string;
  checks: ValidationCheck[];
  errors: ValidationCheck[];
  validatedAt: string;
}

export interface ExecutionStatus {
  strategyId: string;
  state: ExecutionState;
  context: ExecutionContext | null;
  lastValidation: ValidationResult | null;
}

/**
 * Strategy Execution Engine — Phase 1.
 *
 * Responsibilities in scope for this sprint:
 *   - Validate a strategy against the runtime prerequisites.
 *   - Manage an in-memory execution state machine per strategy.
 *   - Maintain an in-memory ExecutionContext while RUNNING / PAUSED.
 *   - Expose start / pause / resume / stop / getExecutionStatus.
 *
 * Explicitly OUT of scope (do not extend here without a new sprint):
 *   - Placing broker orders / trading logic
 *   - Websocket subscriptions
 *   - Any scheduler, cron, queue or background worker
 *   - Persisting execution state to the database
 *   - Follower propagation
 */
@Injectable()
export class StrategyExecutionService {
  private readonly logger = new Logger('StrategyExecution');

  private readonly states = new Map<string, ExecutionState>();
  private readonly contexts = new Map<string, ExecutionContext>();
  private readonly validations = new Map<string, ValidationResult>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerService: BrokerService,
  ) {}

  // ---------------------------------------------------------------------
  // Validation
  // ---------------------------------------------------------------------

  /**
   * Validate a strategy's runtime prerequisites. On success the state
   * machine advances DRAFT/STOPPED/ERROR → READY. On failure the state
   * machine moves to ERROR and a structured list of failed checks is
   * returned so the caller can render actionable feedback.
   */
  async validateStrategy(strategyId: string): Promise<ValidationResult> {
    const checks: ValidationCheck[] = [];

    // 1) Strategy exists
    const strategy = await this.prisma.strategy.findUnique({
      where: { id: strategyId },
      include: { tradingAccount: true },
    });
    checks.push({
      key: 'strategy_exists',
      ok: !!strategy,
      message: strategy
        ? `Strategy ${strategy.strategyName} found`
        : 'Strategy not found',
    });

    if (!strategy) {
      return this.finaliseValidation(strategyId, checks);
    }

    // 2) Strategy is active
    const active = strategy.enabled && strategy.status === 'ACTIVE';
    checks.push({
      key: 'strategy_active',
      ok: active,
      message: active
        ? 'Strategy is enabled and status is ACTIVE'
        : `Strategy is not active (enabled=${strategy.enabled}, status=${strategy.status})`,
    });

    // 3) Master account exists (strategy's tradingAccount must be MASTER)
    const account = strategy.tradingAccount;
    const masterOk = !!account && account.accountType === 'MASTER';
    checks.push({
      key: 'master_account_exists',
      ok: masterOk,
      message: !account
        ? 'Trading account for strategy not found'
        : masterOk
        ? `Master account ${account.nickname} (${account.broker}) available`
        : `Trading account ${account.nickname} is not a MASTER account`,
    });

    // 4) Broker session exists + 5) Broker session healthy
    if (account) {
      try {
        const health = await this.brokerService.getSessionHealth(account.id);
        const hasSession = !!health.loginTime;
        checks.push({
          key: 'broker_session_exists',
          ok: hasSession,
          message: hasSession
            ? `Broker session present (loginTime=${health.loginTime})`
            : 'No broker session found for master account',
        });

        const healthy =
          hasSession &&
          health.connectionStatus === ConnectionStatus.CONNECTED &&
          health.sessionActive === true &&
          health.tokenExpired !== true;
        checks.push({
          key: 'broker_session_healthy',
          ok: healthy,
          message: healthy
            ? 'Broker session is CONNECTED and token is not expired'
            : `Broker session unhealthy (status=${health.connectionStatus}, tokenExpired=${health.tokenExpired})`,
        });
      } catch (err: any) {
        // getSessionHealth throws NotFoundException if the trading account
        // vanishes between reads — surface as a failed check, not a 500.
        checks.push({
          key: 'broker_session_exists',
          ok: false,
          message:
            err?.message ?? 'Failed to read broker session for master account',
        });
        checks.push({
          key: 'broker_session_healthy',
          ok: false,
          message: 'Skipped health probe — broker session unreachable',
        });
      }

      // 6) Instrument mappings valid — the engine needs at least one
      //    InstrumentBroker row for the master account's broker so it can
      //    resolve symbols at order time. Zero rows means the broker's
      //    instrument universe has not been imported.
      const mappingCount = await this.prisma.instrumentBroker.count({
        where: { broker: account.broker as Broker },
      });
      checks.push({
        key: 'instrument_mappings_valid',
        ok: mappingCount > 0,
        message:
          mappingCount > 0
            ? `${mappingCount.toLocaleString()} instrument mappings loaded for ${account.broker}`
            : `No instrument mappings loaded for ${account.broker} — run an import first`,
      });
    } else {
      checks.push({
        key: 'broker_session_exists',
        ok: false,
        message: 'Skipped — trading account missing',
      });
      checks.push({
        key: 'broker_session_healthy',
        ok: false,
        message: 'Skipped — trading account missing',
      });
      checks.push({
        key: 'instrument_mappings_valid',
        ok: false,
        message: 'Skipped — trading account missing',
      });
    }

    return this.finaliseValidation(strategyId, checks);
  }

  private finaliseValidation(
    strategyId: string,
    checks: ValidationCheck[],
  ): ValidationResult {
    const errors = checks.filter((c) => !c.ok);
    const ok = errors.length === 0;
    const result: ValidationResult = {
      ok,
      strategyId,
      checks,
      errors,
      validatedAt: new Date().toISOString(),
    };
    this.validations.set(strategyId, result);

    const current = this.states.get(strategyId) ?? ExecutionState.DRAFT;
    if (ok) {
      // Advance to READY only from states where that transition is legal.
      if (isTransitionAllowed(current, ExecutionState.READY)) {
        this.states.set(strategyId, ExecutionState.READY);
      } else if (current === ExecutionState.DRAFT) {
        this.states.set(strategyId, ExecutionState.READY);
      }
    } else {
      this.logger.warn(
        `Validation failed for strategy ${strategyId}: ${errors
          .map((e) => e.key)
          .join(', ')}`,
      );
      // Move to ERROR unless we're already RUNNING/PAUSED (don't yank
      // an actively executing strategy just because a stale re-validation
      // failed — the caller is expected to stop() explicitly).
      if (
        current !== ExecutionState.RUNNING &&
        current !== ExecutionState.PAUSED
      ) {
        this.states.set(strategyId, ExecutionState.ERROR);
      }
    }

    return result;
  }

  // ---------------------------------------------------------------------
  // Lifecycle transitions
  // ---------------------------------------------------------------------

  async startStrategy(strategyId: string): Promise<ExecutionStatus> {
    const validation = await this.validateStrategy(strategyId);
    if (!validation.ok) {
      // finaliseValidation already put us in ERROR; surface as 409 with
      // the structured checks so the operator can act on it.
      throw new ConflictException({
        message: 'Strategy failed pre-flight validation',
        strategyId,
        errors: validation.errors,
      });
    }

    // After a green validation we should be in READY. If not, refuse.
    this.assertTransition(strategyId, ExecutionState.RUNNING);

    const strategy = await this.prisma.strategy.findUnique({
      where: { id: strategyId },
      include: { tradingAccount: true },
    });
    if (!strategy || !strategy.tradingAccount) {
      // Guarded by validation above; kept for type-narrowing safety.
      throw new NotFoundException('Strategy not found');
    }

    const now = new Date().toISOString();
    const context: ExecutionContext = {
      strategyId: strategy.id,
      masterAccountId: strategy.tradingAccount.id,
      broker: strategy.tradingAccount.broker,
      status: ExecutionState.RUNNING,
      startedAt: now,
      lastHeartbeat: now,
      lastError: null,
    };
    this.contexts.set(strategyId, context);
    this.states.set(strategyId, ExecutionState.RUNNING);

    this.logger.log(
      `Starting strategy ${strategyId} on ${strategy.tradingAccount.broker} (masterAccount=${strategy.tradingAccount.id})`,
    );

    return this.buildStatus(strategyId);
  }

  async pauseStrategy(strategyId: string): Promise<ExecutionStatus> {
    this.assertTransition(strategyId, ExecutionState.PAUSED);
    this.states.set(strategyId, ExecutionState.PAUSED);
    const ctx = this.contexts.get(strategyId);
    if (ctx) {
      ctx.status = ExecutionState.PAUSED;
      ctx.lastHeartbeat = new Date().toISOString();
    }
    this.logger.log(`Paused strategy ${strategyId}`);
    return this.buildStatus(strategyId);
  }

  async resumeStrategy(strategyId: string): Promise<ExecutionStatus> {
    this.assertTransition(strategyId, ExecutionState.RUNNING);
    // On resume we DO NOT re-run validation — the operator has decided
    // the environment is still valid. A fresh validate call is a
    // separate, explicit action.
    this.states.set(strategyId, ExecutionState.RUNNING);
    const ctx = this.contexts.get(strategyId);
    if (ctx) {
      ctx.status = ExecutionState.RUNNING;
      ctx.lastHeartbeat = new Date().toISOString();
    }
    this.logger.log(`Resumed strategy ${strategyId}`);
    return this.buildStatus(strategyId);
  }

  async stopStrategy(strategyId: string): Promise<ExecutionStatus> {
    this.assertTransition(strategyId, ExecutionState.STOPPED);
    this.states.set(strategyId, ExecutionState.STOPPED);
    // Context is torn down so the next start() rebuilds fresh timestamps.
    this.contexts.delete(strategyId);
    this.logger.log(`Stopped strategy ${strategyId}`);
    return this.buildStatus(strategyId);
  }

  getExecutionStatus(strategyId: string): ExecutionStatus {
    return this.buildStatus(strategyId);
  }

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  private assertTransition(strategyId: string, next: ExecutionState) {
    const current = this.states.get(strategyId) ?? ExecutionState.DRAFT;
    if (!isTransitionAllowed(current, next)) {
      throw new ConflictException({
        message: `Invalid state transition ${current} → ${next} for strategy ${strategyId}`,
        strategyId,
        from: current,
        to: next,
      });
    }
  }

  private buildStatus(strategyId: string): ExecutionStatus {
    return {
      strategyId,
      state: this.states.get(strategyId) ?? ExecutionState.DRAFT,
      context: this.contexts.get(strategyId) ?? null,
      lastValidation: this.validations.get(strategyId) ?? null,
    };
  }
}
