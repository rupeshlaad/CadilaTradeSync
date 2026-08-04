import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.module';
import {
  TradeEvent,
  TradeEventReadinessCheck,
  TradeEventReadinessResult,
  TradeEventValidationResult,
} from './trade-event';

/**
 * Execution-readiness gate — the final foundation-only step in the
 * intake pipeline.
 *
 * Runs AFTER validation on already-VALIDATED events and decides
 * whether the event should be exposed to downstream consumers
 * (e.g. CopyTradingService) as READY.
 *
 * Deliberately narrow: this gate does NOT re-check validation-scope
 * facts (broker session, strategy state, instrument mapping, ...).
 * Those already gate whether the event survives validation.
 *
 * The readiness gate only asks:
 *   "Assuming the event is validated, is there anything actually
 *    downstream to react to?"
 *
 * For the foundation that reduces to: does the strategy have at least
 * one enabled follower? If not, the event stays at status = VALIDATED
 * with ready = false — it is a benign "nothing to do" outcome, not a
 * pipeline error.
 *
 * This service NEVER places orders, NEVER queues, NEVER schedules and
 * NEVER touches broker APIs.
 */
@Injectable()
export class TradeEventReadinessService {
  private readonly logger = new Logger('TradeEventReadiness');

  constructor(private readonly prisma: PrismaService) {}

  async assess(
    event: TradeEvent,
    validation: TradeEventValidationResult | null,
  ): Promise<TradeEventReadinessResult> {
    const checks: TradeEventReadinessCheck[] = [];

    // 1) Validation must have passed. If it didn't, we short-circuit
    //    with a single failing check so the admin UI still gets a
    //    structured readiness slot rather than a null.
    const validationPassed = !!validation && validation.ok;
    checks.push({
      key: 'validation_passed',
      ok: validationPassed,
      message: validation
        ? validation.ok
          ? 'Validation passed'
          : `Validation failed with ${validation.errors.length} error(s)`
        : 'Validation was not run',
    });

    if (!validationPassed) {
      return this.finalise(checks, 'Validation must pass before readiness');
    }

    // 2) At least one enabled follower on the strategy. Zero followers
    //    means the copy-trading pipeline has nothing to fan out even
    //    if the master trade is perfectly valid.
    if (!event.strategyId) {
      checks.push({
        key: 'has_enabled_followers',
        ok: false,
        message: 'Skipped — no strategyId on event',
      });
      return this.finalise(checks, 'No strategy resolved for event');
    }

    let followerCount = 0;
    try {
      followerCount = await this.prisma.follower.count({
        where: {
          strategyId: event.strategyId,
          enabled: true,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Follower count lookup failed for strategy ${event.strategyId}: ${(err as Error).message}`,
      );
      checks.push({
        key: 'has_enabled_followers',
        ok: false,
        message: `Failed to read followers: ${(err as Error).message}`,
      });
      return this.finalise(checks, 'Follower lookup failed');
    }

    const hasFollowers = followerCount > 0;
    checks.push({
      key: 'has_enabled_followers',
      ok: hasFollowers,
      message: hasFollowers
        ? `${followerCount} enabled follower(s) subscribed to strategy`
        : 'No enabled followers subscribed to strategy',
    });

    return this.finalise(
      checks,
      hasFollowers ? null : 'No enabled followers subscribed to strategy',
    );
  }

  private finalise(
    checks: TradeEventReadinessCheck[],
    reason: string | null,
  ): TradeEventReadinessResult {
    const errors = checks.filter((c) => !c.ok);
    const ready = errors.length === 0;
    return {
      ready,
      checks,
      errors,
      reason: ready ? null : reason,
      assessedAt: new Date().toISOString(),
    };
  }
}
