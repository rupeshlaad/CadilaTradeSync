import { Injectable } from '@nestjs/common';

import {
  ExecutionEvent,
  ExecutionEventSummary,
  ExecutionFailureType,
  ExecutionFollowerStatus,
  FollowerExecution,
} from './execution-event';

const BUFFER_CAPACITY = 100;

/**
 * In-memory recorder for real copy-trading execution events.
 *
 * `CopyTradingService.handleTrade` opens a builder via `begin(...)`, walks it
 * as followers are attempted, and commits it at the end. Nothing here talks
 * to the broker, the database, or any queue; the recorder exists purely as
 * an operational-visibility side-channel and is intentionally decoupled from
 * the copy-trading control flow so it can never influence order placement.
 *
 * Buffer holds the last {@link BUFFER_CAPACITY} finalised events (newest first).
 */
@Injectable()
export class ExecutionEventRecorderService {
  private readonly buffer: ExecutionEvent[] = [];
  private totalRecorded = 0;
  private readonly commitHandlers: Array<
    (event: ExecutionEvent) => void | Promise<void>
  > = [];

  /**
   * Register a side-effect that fires (fire-and-forget) after every
   * builder.commit() lands an event in the buffer. Errors thrown by
   * subscribers are swallowed here so a persistence failure can never
   * block the in-memory recorder or CopyTradingService.handleTrade.
   *
   * Used by ExecutionHistoryPersistenceService to write the same
   * event to the permanent execution audit trail (Sprint 5.2).
   */
  onCommit(handler: (event: ExecutionEvent) => void | Promise<void>) {
    this.commitHandlers.push(handler);
  }

  begin(seed: {
    masterAccountId: string;
    masterAccountNickname: string | null;
    broker: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    price?: number | null;
    productType: string;
    orderType?: string | null;
    tradeSource?: string | null;
    masterExchange?: string | null;
    masterSegment?: string | null;
    orderId: string | null;
    timestamp?: string | Date | null;
  }): ExecutionEventBuilder {
    const nowIso = new Date().toISOString();
    const eventTs =
      seed.timestamp instanceof Date
        ? seed.timestamp.toISOString()
        : typeof seed.timestamp === 'string'
        ? seed.timestamp
        : nowIso;

    const event: ExecutionEvent = {
      id: `xe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}${
        seed.orderId ? `_${seed.orderId}` : ''
      }`,
      timestamp: eventTs,
      strategyId: null,
      strategyName: null,
      masterAccountId: seed.masterAccountId,
      masterAccountNickname: seed.masterAccountNickname,
      broker: seed.broker,
      symbol: seed.symbol,
      side: seed.side,
      quantity: seed.quantity,
      price: seed.price ?? null,
      productType: seed.productType,
      orderType: seed.orderType ?? null,
      tradeSource: seed.tradeSource ?? 'BROKER_POLL',
      masterExchange: seed.masterExchange ?? null,
      masterSegment: seed.masterSegment ?? null,
      followersFound: 0,
      followers: [],
      outcome: 'FANNED_OUT',
      errorReason: null,
      processingTimeMs: null,
    };

    const startedAtMs = Date.now();

    return new ExecutionEventBuilder(event, (finalised) => {
      finalised.processingTimeMs = Math.max(0, Date.now() - startedAtMs);
      this.commit(finalised);
    });
  }

  getRecent(limit = 20): ExecutionEvent[] {
    const capped = Math.min(Math.max(limit, 1), BUFFER_CAPACITY);
    return this.buffer.slice(0, capped);
  }

  getById(id: string): ExecutionEvent | null {
    return this.buffer.find((e) => e.id === id) ?? null;
  }

  getSummary(): ExecutionEventSummary {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const startMs = startOfDay.getTime();

    let events = 0;
    let successfulOrders = 0;
    let failedOrders = 0;
    let pendingOrders = 0;
    let followersExecuted = 0;

    for (const e of this.buffer) {
      const ts = new Date(e.timestamp).getTime();
      if (Number.isFinite(ts) && ts >= startMs) {
        events++;
        for (const f of e.followers) {
          if (f.status === 'SUCCESS') successfulOrders++;
          else if (f.status === 'FAILED') failedOrders++;
          else if (f.status === 'PENDING' || f.status === 'EXECUTING')
            pendingOrders++;
          if (f.status === 'SUCCESS' || f.status === 'FAILED')
            followersExecuted++;
        }
      }
    }

    return {
      totalRecorded: this.totalRecorded,
      bufferSize: this.buffer.length,
      bufferCapacity: BUFFER_CAPACITY,
      today: {
        events,
        successfulOrders,
        failedOrders,
        pendingOrders,
        followersExecuted,
      },
      latest: this.buffer[0] ?? null,
    };
  }

  // ---------------------------------------------------------------------
  private commit(event: ExecutionEvent) {
    this.buffer.unshift(event);
    if (this.buffer.length > BUFFER_CAPACITY) {
      this.buffer.length = BUFFER_CAPACITY;
    }
    this.totalRecorded++;

    // Fire-and-forget subscribers. Persistence errors must never
    // interfere with CopyTradingService.handleTrade.
    for (const handler of this.commitHandlers) {
      try {
        Promise.resolve(handler(event)).catch(() => {
          /* swallowed intentionally — subscriber owns its own logging */
        });
      } catch {
        /* swallowed intentionally */
      }
    }
  }
}

/**
 * Fluent handle threaded through CopyTradingService for a single master trade.
 * Every mutation stays local to the in-progress event until `commit()` is
 * called (or `abort(reason)` for a top-level exception), at which point the
 * event lands in the recorder's ring buffer.
 */
export class ExecutionEventBuilder {
  private followerSeq = 0;

  constructor(
    private readonly event: ExecutionEvent,
    private readonly onCommit: (event: ExecutionEvent) => void,
  ) {}

  get id() {
    return this.event.id;
  }

  setStrategy(strategy: { id: string; name: string } | null) {
    if (strategy) {
      this.event.strategyId = strategy.id;
      this.event.strategyName = strategy.name;
    } else {
      this.event.strategyId = null;
      this.event.strategyName = null;
    }
  }

  setMasterNickname(nickname: string | null) {
    this.event.masterAccountNickname = nickname;
  }

  setFollowersFound(count: number) {
    this.event.followersFound = count;
  }

  markNoActiveStrategy() {
    this.event.outcome = 'NO_ACTIVE_STRATEGY';
  }

  markNoEnabledFollowers() {
    this.event.outcome = 'NO_ENABLED_FOLLOWERS';
  }

  markTopLevelError(reason: string) {
    this.event.outcome = 'ERROR';
    this.event.errorReason = reason;
  }

  /**
   * Register a follower that CopyTradingService is about to attempt. The
   * returned handle exposes fine-grained state transitions so the recorder
   * mirrors the real execution flow (PENDING → EXECUTING → SUCCESS/FAILED).
   */
  addFollower(seed: {
    followerId: string;
    followerName: string;
    followerEmail: string;
    followerAccountId: string;
    broker: string;
  }): FollowerExecutionHandle {
    const rec: FollowerExecution = {
      id: `xef_${this.event.id}_${++this.followerSeq}`,
      followerId: seed.followerId,
      followerName: seed.followerName,
      followerEmail: seed.followerEmail,
      followerAccountId: seed.followerAccountId,
      broker: seed.broker,
      status: 'PENDING',
      failureType: null,
      reason: null,
      brokerResponse: null,
      followerSymbol: null,
      quantity: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
    };
    this.event.followers.push(rec);
    return new FollowerExecutionHandle(rec);
  }

  commit() {
    this.onCommit(this.event);
  }
}

export class FollowerExecutionHandle {
  constructor(private readonly rec: FollowerExecution) {}

  setStatus(status: ExecutionFollowerStatus) {
    this.rec.status = status;
    if (status === 'SUCCESS' || status === 'FAILED' || status === 'SKIPPED') {
      this.rec.completedAt = new Date().toISOString();
    }
  }

  setBrokerSymbol(symbol: string | null) {
    this.rec.followerSymbol = symbol;
  }

  setQuantity(qty: number | null) {
    this.rec.quantity = qty;
  }

  setBrokerResponse(response: unknown) {
    this.rec.brokerResponse = response;
  }

  fail(failureType: ExecutionFailureType, reason: string, brokerResponse?: unknown) {
    this.rec.status = 'FAILED';
    this.rec.failureType = failureType;
    this.rec.reason = reason;
    if (brokerResponse !== undefined) this.rec.brokerResponse = brokerResponse;
    this.rec.completedAt = new Date().toISOString();
  }

  skip(failureType: ExecutionFailureType, reason: string) {
    this.rec.status = 'SKIPPED';
    this.rec.failureType = failureType;
    this.rec.reason = reason;
    this.rec.completedAt = new Date().toISOString();
  }

  succeed(brokerResponse: unknown) {
    this.rec.status = 'SUCCESS';
    this.rec.brokerResponse = brokerResponse;
    this.rec.completedAt = new Date().toISOString();
  }
}

/**
 * Best-effort classification of a broker/error surface. Kept as a small
 * pure function so both CopyTradingService and any future adapter caller
 * can reuse it without importing the recorder itself.
 */
export function classifyFailure(input: {
  message?: string | null;
  response?: any;
}): ExecutionFailureType {
  const raw = [
    input.message ?? '',
    typeof input.response === 'string' ? input.response : '',
    input.response?.message ?? '',
    input.response?.error ?? '',
    input.response?.emsg ?? '',
    input.response?.code ?? '',
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (!raw) return 'UNKNOWN';
  if (raw.includes('ip') && raw.includes('whitelist')) return 'IP_WHITELIST';
  if (raw.includes('token') && (raw.includes('expire') || raw.includes('invalid')))
    return 'TOKEN_EXPIRED';
  if (raw.includes('instrument') && raw.includes('not')) return 'INSTRUMENT_NOT_FOUND';
  if (raw.includes('reject')) return 'ORDER_REJECTED';
  if (raw.includes('validation')) return 'VALIDATION_FAILED';
  return 'BROKER_ERROR';
}
