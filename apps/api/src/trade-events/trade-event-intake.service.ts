import { Injectable, Logger } from '@nestjs/common';

import { TradeEventNormalizationService } from './trade-event-normalization.service';
import { TradeEventValidationService } from './trade-event-validation.service';
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
 * The intake service:
 *   1. Normalizes the raw broker payload into a canonical TradeEvent.
 *   2. De-duplicates against recently seen (broker, orderId, execId)
 *      triples so a broker re-broadcast never enters the pipeline
 *      twice. The dedupe cache is bounded (~last 500 events) and lives
 *      in-process only — this is intentional; a durable dedupe store
 *      is deferred to a later sprint per the "no persistence" rule.
 *   3. Validates the event via TradeEventValidationService.
 *   4. Records the result in a bounded recent-events buffer so the
 *      admin UI can render the "Trade Event Pipeline" panel.
 *
 * The service intentionally DOES NOT:
 *   - Place broker orders.
 *   - Fan the event out to follower accounts.
 *   - Retry, queue, or schedule anything.
 *   - Poll or subscribe to broker websockets.
 * Those responsibilities belong to future sprints; this sprint only
 * defines the intake contract so upstream listeners can call `ingest()`
 * uniformly.
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

    // 2) Dedupe on (broker, orderId, executionId)
    const key = this.dedupeKey(event);
    if (this.dedupe.has(key)) {
      event = { ...event, status: TradeEventStatus.DUPLICATE };
      const record: TradeEventRecord = {
        event,
        validation: null,
        rejectionReason: 'Duplicate broker event ignored',
      };
      this.push(record);
      this.logger.log(`TradeEvent ${event.id} ignored — duplicate of ${key}`);
      return record;
    }
    this.remember(key);

    // 3) Validate
    const validation = await this.validation.validate(event);
    event = {
      ...event,
      status: validation.ok
        ? TradeEventStatus.VALIDATED
        : TradeEventStatus.REJECTED,
    };

    const record: TradeEventRecord = {
      event,
      validation,
      rejectionReason: validation.ok
        ? null
        : validation.errors.map((e) => `${e.key}: ${e.message}`).join('; '),
    };
    this.push(record);

    if (validation.ok) {
      this.logger.log(
        `TradeEvent ${event.id} validated — ${event.broker} ${event.brokerSymbol} ${event.side} ${event.quantity}`,
      );
    } else {
      this.logger.warn(
        `TradeEvent ${event.id} rejected — ${record.rejectionReason}`,
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
   * Lightweight pipeline overview: counts per status across the
   * currently-buffered records (bounded window, so this is a rolling
   * summary, not a lifetime aggregate).
   */
  getPipelineSummary() {
    const summary: Record<TradeEventStatus, number> = {
      [TradeEventStatus.RECEIVED]: 0,
      [TradeEventStatus.NORMALIZED]: 0,
      [TradeEventStatus.VALIDATED]: 0,
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
      status: TradeEventStatus.REJECTED,
      brokerTimestamp: null,
      receivedAt: nowIso,
      raw: raw?.raw ?? raw,
    };
    return { event, validation: null, rejectionReason: reason };
  }
}
