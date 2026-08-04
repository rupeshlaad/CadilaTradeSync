import { Injectable } from '@nestjs/common';
import { AccountType, Broker, ConnectionStatus } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.module';
import { BrokerService } from '../brokers/broker.service';
import { InstrumentResolverService } from '../instruments/instrument-resolver.service';

import {
  ManualTradeValidationCheck,
  ManualTradeValidationResult,
} from './manual-trade.types';
import { PlaceManualTradeDto } from './manual-trade.dto';

/**
 * Sprint 5.4 — Pre-flight validation for a manual trade request.
 *
 * Runs every check listed in the sprint spec:
 *   - Master account connected
 *   - Broker session active
 *   - Strategy active
 *   - Follower count > 0
 *   - Instrument exists
 *   - Broker symbol mapping exists
 *   - Required fields present (with order-type-specific rules)
 *
 * The service is intentionally read-only — it never places, modifies
 * or persists anything. On success the caller can safely proceed to
 * broker placement; on failure the caller returns 400 with the
 * structured error list so the UI can render actionable feedback.
 */
@Injectable()
export class ManualTradeValidatorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brokerService: BrokerService,
    private readonly resolver: InstrumentResolverService,
  ) {}

  async validate(dto: PlaceManualTradeDto): Promise<
    ManualTradeValidationResult & {
      /** Populated on success — the resolved master account row. */
      resolvedMaster?: {
        id: string;
        broker: Broker;
        nickname: string;
      };
      /** Populated on success — the resolved strategy row. */
      resolvedStrategy?: {
        id: string;
        name: string;
        followerCount: number;
      };
    }
  > {
    const checks: ManualTradeValidationCheck[] = [];
    let resolvedMaster:
      | { id: string; broker: Broker; nickname: string }
      | undefined;
    let resolvedStrategy:
      | { id: string; name: string; followerCount: number }
      | undefined;

    // 1) Required fields — order-type-specific requirements.
    const fieldErrors = requiredFieldErrors(dto);
    checks.push({
      key: 'required_fields_present',
      ok: fieldErrors.length === 0,
      message:
        fieldErrors.length === 0
          ? 'All required fields for the selected order type are present'
          : fieldErrors.join('; '),
    });

    // 2) Master account exists + is a MASTER
    const master = await this.prisma.tradingAccount.findUnique({
      where: { id: dto.masterAccountId },
      select: {
        id: true,
        broker: true,
        nickname: true,
        accountType: true,
        enabled: true,
        connectionStatus: true,
      },
    });
    const masterOk =
      !!master &&
      master.accountType === AccountType.MASTER &&
      master.enabled === true;
    checks.push({
      key: 'master_account_exists',
      ok: masterOk,
      message: !master
        ? 'Master account not found'
        : master.accountType !== AccountType.MASTER
        ? `Trading account ${master.nickname} is not a MASTER account`
        : !master.enabled
        ? `Master account ${master.nickname} is disabled`
        : `Master account ${master.nickname} (${master.broker}) resolved`,
    });

    // 3) Master account connected + 4) Broker session healthy
    if (master) {
      resolvedMaster = {
        id: master.id,
        broker: master.broker,
        nickname: master.nickname,
      };

      const connected = master.connectionStatus === ConnectionStatus.CONNECTED;
      checks.push({
        key: 'master_account_connected',
        ok: connected,
        message: connected
          ? `Master account is CONNECTED`
          : `Master account connectionStatus=${master.connectionStatus} (must be CONNECTED)`,
      });

      let sessionHealthy = false;
      try {
        const health = await this.brokerService.getSessionHealth(master.id);
        sessionHealthy =
          !!health.loginTime &&
          health.connectionStatus === ConnectionStatus.CONNECTED &&
          health.sessionActive === true &&
          health.tokenExpired !== true;
        checks.push({
          key: 'broker_session_healthy',
          ok: sessionHealthy,
          message: sessionHealthy
            ? `Broker session healthy (loginTime=${health.loginTime})`
            : `Broker session unhealthy (status=${health.connectionStatus}, tokenExpired=${health.tokenExpired})`,
        });
      } catch (err: any) {
        checks.push({
          key: 'broker_session_healthy',
          ok: false,
          message:
            err?.message ??
            'Failed to read broker session for master account',
        });
      }
    } else {
      checks.push({
        key: 'master_account_connected',
        ok: false,
        message: 'Skipped — master account not found',
      });
      checks.push({
        key: 'broker_session_healthy',
        ok: false,
        message: 'Skipped — master account not found',
      });
    }

    // 5) Strategy active + 6) Strategy belongs to master + 7) Followers
    const strategy = await this.prisma.strategy.findUnique({
      where: { id: dto.strategyId },
      select: {
        id: true,
        strategyName: true,
        status: true,
        enabled: true,
        masterAccount: true,
        tradingAccountId: true,
      },
    });

    const strategyActive =
      !!strategy && strategy.enabled === true && strategy.status === 'ACTIVE';
    checks.push({
      key: 'strategy_active',
      ok: strategyActive,
      message: !strategy
        ? 'Strategy not found'
        : strategyActive
        ? `Strategy ${strategy.strategyName} is enabled and ACTIVE`
        : `Strategy ${strategy.strategyName} is not active (enabled=${strategy.enabled}, status=${strategy.status})`,
    });

    const strategyLinked =
      !!strategy &&
      strategy.tradingAccountId === dto.masterAccountId &&
      strategy.masterAccount === true;
    checks.push({
      key: 'strategy_belongs_to_master',
      ok: strategyLinked,
      message: !strategy
        ? 'Skipped — strategy not found'
        : strategyLinked
        ? 'Strategy is linked to the selected master account'
        : 'Strategy does not belong to the selected master account, or is not marked as a master strategy',
    });

    if (strategy) {
      const followerCount = await this.prisma.follower.count({
        where: { strategyId: strategy.id, enabled: true },
      });
      const hasFollowers = followerCount > 0;
      checks.push({
        key: 'strategy_has_enabled_followers',
        ok: hasFollowers,
        message: hasFollowers
          ? `${followerCount} enabled follower(s) subscribed`
          : 'No enabled followers are subscribed to this strategy',
      });
      resolvedStrategy = {
        id: strategy.id,
        name: strategy.strategyName,
        followerCount,
      };
    } else {
      checks.push({
        key: 'strategy_has_enabled_followers',
        ok: false,
        message: 'Skipped — strategy not found',
      });
    }

    // 8) Instrument exists + 9) Broker symbol mapping exists
    let instrumentOk = false;
    let mappingOk = false;
    if (master) {
      const mapping = await this.resolver.resolveByBrokerSymbol(
        master.broker,
        dto.symbol,
      );
      instrumentOk = !!mapping;
      mappingOk = !!mapping;
      checks.push({
        key: 'instrument_exists',
        ok: instrumentOk,
        message: instrumentOk
          ? `Instrument resolved (${mapping!.instrument.contractKey})`
          : `Instrument not found for ${master.broker} symbol "${dto.symbol}"`,
      });
      checks.push({
        key: 'broker_symbol_mapping_exists',
        ok: mappingOk,
        message: mappingOk
          ? `Broker symbol mapping present on ${master.broker}`
          : `No InstrumentBroker mapping for ${master.broker} / "${dto.symbol}" — run an instrument import first`,
      });
    } else {
      checks.push({
        key: 'instrument_exists',
        ok: false,
        message: 'Skipped — master account not found',
      });
      checks.push({
        key: 'broker_symbol_mapping_exists',
        ok: false,
        message: 'Skipped — master account not found',
      });
    }

    const errors = checks.filter((c) => !c.ok);
    return {
      ok: errors.length === 0,
      checks,
      errors,
      validatedAt: new Date().toISOString(),
      resolvedMaster,
      resolvedStrategy,
    };
  }
}

/**
 * Order-type-specific required-field rules. Only the base numeric
 * range / non-empty checks are handled by class-validator; contextual
 * rules ("LIMIT orders need a price", "SL orders need a trigger
 * price") live here so the failure surface stays consistent.
 */
function requiredFieldErrors(dto: PlaceManualTradeDto): string[] {
  const errors: string[] = [];

  const needsPrice = dto.orderType === 'LIMIT' || dto.orderType === 'SL';
  const needsTrigger = dto.orderType === 'SL' || dto.orderType === 'SL-M';

  if (needsPrice && (dto.price === undefined || dto.price <= 0)) {
    errors.push(`${dto.orderType} orders require a positive price`);
  }
  if (needsTrigger && (dto.triggerPrice === undefined || dto.triggerPrice <= 0)) {
    errors.push(`${dto.orderType} orders require a positive triggerPrice`);
  }
  if (dto.orderType === 'MARKET' && dto.price !== undefined && dto.price > 0) {
    // Not fatal, but callers should be aware — surface as a message only.
  }
  return errors;
}
