import { Injectable, Logger } from '@nestjs/common';

import { TradeEventNormalizationService } from './trade-event-normalization.service';
import { TradeEventValidationService } from './trade-event-validation.service';
import { TradeEventReadinessService } from './trade-event-readiness.service';
import {
  RawBrokerTrade,
  TradeEvent,
  TradeEventRecord,
  TradeEventSource,
  TradeEventStatus,
} from './trade-event';

const RECENT_BUFFER_SIZE = 50;
const DEDUPE_CACHE_SIZE = 500;

/**
 * Public entry point for broker listeners / pollers / manual entries.
 *
 * The intake service formalises the internal Trade Event pipeline that
 * every executed master trade must traverse before the copy-trading
 * engine may act on it:
 *
 *   Trade Event
 *     ↓
 *   Normalization          (broker payload → canonical TradeEvent)
 *     ↓
 *   Validation             (structured, pre-execution checks)
 *     ↓
 *   Execution Readiness    (are there downstream consumers to react?)
 *     ↓
 *   Available for downstream CopyTradingService (status = READY)
 *
 * The service intentionally DOES NOT:
 *   - Place broker orders.
 *   - Fan the event out to follower accounts.
 *   - Retry, queue, or schedule anything.
 *   - Poll or subscribe to broker websockets.
 * Those responsibilities belong to future sprints; this sprint only
 * defines the intake contract so upstream listeners can call `ingest()`
 * uniformly and downstream consumers can watch for READY records.
 */
@Injectable()
export class TradeEventIntakeService {
  private readonly logger = new Logger('TradeEventIntake');

  private readonly recent: TradeEventRecord[] = [];
  private readonly dedupe = new Set<string>();
  private readonly dedupeOrder: string[] = [];

  constructor(
    private readonly normalization: TradeEventNormalizationService,
    private readonly validation: TradeEventValidationService,
    private readonly readiness: TradeEventReadinessService,
  ) {}

  /**
   * Push a raw broker payload through the intake pipeline. Always
   * returns a TradeEventRecord (even for REJECTED / DUPLICATE) so
   * callers can log or forward it consistently.
   */
  async ingest(raw: RawBrokerTrade): Promise<TradeEventRecord> {
    // 1) Normalize
    const outcome = await this.normalization.normalize(raw);
    if (!outcome.ok || !outcome.event) {
      const rejection = this.buildRejection(raw, outcome.reason ?? 'Malformed event');
      this.push(rejection);
      this.logger.warn(
        `TradeEvent rejected during normalization: ${rejection.rejectionReason}`,
      );
      return rejection;
    }

    let event = outcome.event;

    // 2) Dedupe on (broker, orderId, executionId). Duplicates still
    //    run through validation with `wasDuplicate=true` so the admin
    //    monitor renders a consistent structured record (including the
    //    not_duplicate check). Only the final status differs.
    const key = this.dedupeKey(event);
    const wasDuplicate = this.dedupe.has(key);
    if (!wasDuplicate) this.remember(key);

    // 3) Validate
    const validation = await this.validation.validate(event, { wasDuplicate });

    if (wasDuplicate) {
      event = { ...event, status: TradeEventStatus.DUPLICATE };
      const record: TradeEventRecord = {
        event,
        validation,
        readiness: null,
        rejectionReason: 'Duplicate broker event ignored',
      };
      this.push(record);
      this.logger.log(`TradeEvent ${event.id} ignored — duplicate of ${key}`);
      return record;
    }

    if (!validation.ok) {
      event = { ...event, status: TradeEventStatus.REJECTED };
      const record: TradeEventRecord = {
        event,
        validation,
        readiness: null,
        rejectionReason: validation.errors
          .map((e) => `${e.key}: ${e.message}`)
          .join('; '),
      };
      this.push(record);
      this.logger.warn(
        `TradeEvent ${event.id} rejected — ${record.rejectionReason}`,
      );
      return record;
    }

    // 4) Execution Readiness — foundation-only gate. Validated events
    //    that have no downstream consumer stay at VALIDATED with
    //    ready=false; anything else transitions to READY so downstream
    //    services can pick it up.
    event = { ...event, status: TradeEventStatus.VALIDATED };
    const readiness = await this.readiness.assess(event, validation);
    if (readiness.ready) {
      event = { ...event, status: TradeEventStatus.READY };
    }

    const record: TradeEventRecord = {
      event,
      validation,
      readiness,
      rejectionReason: null,
    };
    this.push(record);

    if (readiness.ready) {
      this.logger.log(
        `TradeEvent ${event.id} READY — ${event.broker} ${event.brokerSymbol} ${event.side} ${event.quantity}`,
      );
    } else {
      this.logger.log(
        `TradeEvent ${event.id} VALIDATED but not ready — ${readiness.reason ?? 'unknown'}`,
      );
    }

    return record;
  }

  /**
   * Read-only accessors for the admin UI. Returned records are the
   * most recent first.
   */
  getRecent(limit = 20): TradeEventRecord[] {
    const capped = Math.min(Math.max(limit, 1), RECENT_BUFFER_SIZE);
    return this.recent.slice(0, capped);
  }

  getLatest(): TradeEventRecord | null {
    return this.recent[0] ?? null;
  }

  /**
   * Read-only accessor for downstream consumers that want to react to
   * ready-for-execution events without themselves having to walk the
   * full buffer. Intentionally kept as a pull API — the intake service
   * never pushes to downstream consumers in this foundation.
   */
  getReadyRecent(limit = 20): TradeEventRecord[] {
    return this.getRecent(limit).filter(
      (r) => r.event.status === TradeEventStatus.READY,
    );
  }

  /**
   * Lightweight pipeline overview: counts per status across the
   * currently-buffered records (bounded window, so this is a rolling
   * summary, not a lifetime aggregate).
   */
  getPipelineSummary() {
    const summary: Record<TradeEventStatus, number> = {
      [TradeEventStatus.RECEIVED]: 0,
      [TradeEventStatus.NORMALIZED]: 0,
      [TradeEventStatus.VALIDATED]: 0,
      [TradeEventStatus.READY]: 0,
      [TradeEventStatus.DUPLICATE]: 0,
      [TradeEventStatus.REJECTED]: 0,
    };
    for (const r of this.recent) summary[r.event.status]++;
    return {
      bufferSize: this.recent.length,
      bufferCapacity: RECENT_BUFFER_SIZE,
      counts: summary,
      latest: this.recent[0] ?? null,
    };
  }

  // -----------------------------------------------------------------------
  // helpers
  // -----------------------------------------------------------------------

  private push(record: TradeEventRecord) {
    this.recent.unshift(record);
    if (this.recent.length > RECENT_BUFFER_SIZE) {
      this.recent.length = RECENT_BUFFER_SIZE;
    }
  }

  private remember(key: string) {
    this.dedupe.add(key);
    this.dedupeOrder.push(key);
    while (this.dedupeOrder.length > DEDUPE_CACHE_SIZE) {
      const evicted = this.dedupeOrder.shift();
      if (evicted) this.dedupe.delete(evicted);
    }
  }

  private dedupeKey(e: TradeEvent) {
    return `${e.broker}:${e.brokerOrderId}:${e.brokerExecutionId ?? '-'}`;
  }

  private buildRejection(
    raw: RawBrokerTrade,
    reason: string,
  ): TradeEventRecord {
    const nowIso = new Date().toISOString();
    // Synthesize a minimal, non-guaranteed TradeEvent so the admin UI
    // still gets something to render. Fields we can't safely derive
    // are surfaced as placeholders — the REJECTED status + reason
    // make it clear this event never entered the pipeline proper.
    const event: TradeEvent = {
      id: `rej_${nowIso}_${Math.random().toString(36).slice(2, 10)}`,
      source: raw?.source ?? TradeEventSource.UNKNOWN,
      broker: (raw?.broker ?? 'UNKNOWN') as any,
      masterAccountId:
        typeof raw?.masterAccountId === 'string' ? raw.masterAccountId : '',
      strategyId: null,
      brokerOrderId:
        raw?.brokerOrderId != null ? String(raw.brokerOrderId) : '',
      brokerExecutionId:
        raw?.brokerExecutionId != null ? String(raw.brokerExecutionId) : null,
      brokerSymbol:
        typeof raw?.brokerSymbol === 'string' ? raw.brokerSymbol : '',
      instrumentId: null,
      contractKey: null,
      side: 'BUY',
      quantity: 0,
      price: null,
      rawStatus:
        raw?.rawStatus === undefined || raw?.rawStatus === null
          ? null
          : String(raw.rawStatus),
      status: TradeEventStatus.REJECTED,
      brokerTimestamp: null,
      receivedAt: nowIso,
      raw: raw?.raw ?? raw,
    };
    return {
      event,
      validation: null,
      readiness: null,
      rejectionReason: reason,
    };
  }
}
