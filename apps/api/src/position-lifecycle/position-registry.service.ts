import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Broker } from '@prisma/client';

import { ExecutionEventRecorderService } from '../copy-trading/execution-event.recorder';
import type { ExecutionEvent } from '../copy-trading/execution-event';

import {
  FollowerOrderLink,
  LifecycleEvent,
  LifecycleTimelineEntry,
  OrderSignature,
  PositionRecord,
  PositionState,
} from './lifecycle.types';

/**
 * Sprint 5.3 — Position Registry.
 *
 * Authoritative in-memory view of every master position the platform
 * is currently tracking, plus the follower orders that mirror each.
 *
 * The registry is intentionally in-memory:
 *   - Broker state is the ultimate source of truth; the registry
 *     mirrors it and is rebuilt on the fly from broker polls after a
 *     process restart.
 *   - The permanent execution audit trail (execution_history / Sprint
 *     5.2) remains the durable record of every follower fan-out; the
 *     registry only tracks working state and correlates broker order
 *     ids so lifecycle modify / cancel / exit events can target the
 *     right follower orders.
 *
 * The registry subscribes to `ExecutionEventRecorderService.onCommit`
 * so it can associate follower broker order ids with a master position
 * automatically after every successful `CopyTradingService.handleTrade`
 * fan-out — no additional wiring required in the copy-trading service.
 */
@Injectable()
export class PositionRegistryService implements OnModuleInit {
  private readonly logger = new Logger(PositionRegistryService.name);
  private readonly positions = new Map<string, PositionRecord>();

  constructor(private readonly recorder: ExecutionEventRecorderService) {}

  onModuleInit() {
    // Automatic follower correlation: every time CopyTradingService
    // commits a fan-out we mine the ExecutionEvent for follower broker
    // order ids and attach them to the corresponding master position.
    this.recorder.onCommit((event) => this.correlateFollowersFromEvent(event));
  }

  // -------------------------------------------------------------------------
  // Read
  // -------------------------------------------------------------------------

  buildKey(
    broker: Broker,
    masterAccountId: string,
    brokerOrderId: string,
  ): string {
    return `${broker}:${masterAccountId}:${brokerOrderId}`;
  }

  get(key: string): PositionRecord | null {
    return this.positions.get(key) ?? null;
  }

  find(
    broker: Broker,
    masterAccountId: string,
    brokerOrderId: string,
  ): PositionRecord | null {
    return this.get(this.buildKey(broker, masterAccountId, brokerOrderId));
  }

  list(): PositionRecord[] {
    return Array.from(this.positions.values()).sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt),
    );
  }

  listOpen(): PositionRecord[] {
    return this.list().filter(
      (p) =>
        p.state !== PositionState.CLOSED &&
        p.state !== PositionState.CANCELLED &&
        p.state !== PositionState.REJECTED,
    );
  }

  // -------------------------------------------------------------------------
  // Signatures (dedup gate)
  // -------------------------------------------------------------------------

  /**
   * Compare a freshly-computed signature against the last one recorded
   * for the same master order. Returns true when the signature is new
   * (i.e. the caller should proceed with lifecycle processing).
   */
  hasSignatureChanged(
    key: string,
    signature: OrderSignature,
  ): boolean {
    const existing = this.positions.get(key);
    if (!existing || !existing.lastSignature) return true;
    return !equalSignature(existing.lastSignature, signature);
  }

  // -------------------------------------------------------------------------
  // Write
  // -------------------------------------------------------------------------

  /**
   * Apply a lifecycle event to the registry. Creates the position if
   * it does not yet exist and appends the transition timeline entry.
   */
  applyEvent(
    event: LifecycleEvent,
    nextState: PositionState,
    timelineEntry: LifecycleTimelineEntry,
    signature: OrderSignature,
    strategyId: string | null,
  ): PositionRecord {
    const key = this.buildKey(
      event.broker,
      event.masterAccountId,
      event.brokerOrderId,
    );
    const now = new Date().toISOString();
    const existing = this.positions.get(key);

    const record: PositionRecord = existing
      ? {
          ...existing,
          state: nextState,
          quantity: event.quantity,
          filledQuantity: event.filledQuantity,
          pendingQuantity: event.pendingQuantity,
          price: event.price ?? existing.price,
          triggerPrice: event.triggerPrice ?? existing.triggerPrice,
          productType: event.productType ?? existing.productType,
          orderType: event.orderType ?? existing.orderType,
          strategyId: strategyId ?? existing.strategyId,
          lastSignature: signature,
          timeline: [...existing.timeline, timelineEntry],
          updatedAt: now,
          closedAt: isTerminal(nextState)
            ? existing.closedAt ?? now
            : existing.closedAt,
        }
      : {
          key,
          broker: event.broker,
          masterAccountId: event.masterAccountId,
          brokerOrderId: event.brokerOrderId,
          strategyId,
          symbol: event.symbol,
          exchange: event.exchange,
          side: event.side,
          quantity: event.quantity,
          filledQuantity: event.filledQuantity,
          pendingQuantity: event.pendingQuantity,
          price: event.price,
          triggerPrice: event.triggerPrice,
          productType: event.productType,
          orderType: event.orderType,
          state: nextState,
          lastSignature: signature,
          timeline: [timelineEntry],
          followers: [],
          createdAt: now,
          updatedAt: now,
          closedAt: isTerminal(nextState) ? now : null,
        };

    this.positions.set(key, record);
    return record;
  }

  /**
   * Update the signature only (no state change) — used when the state
   * machine rejects a transition but we still want to remember what
   * we last saw so we do not reprocess the same broker echo forever.
   */
  rememberSignature(key: string, signature: OrderSignature): void {
    const existing = this.positions.get(key);
    if (!existing) return;
    existing.lastSignature = signature;
    existing.updatedAt = new Date().toISOString();
  }

  /**
   * Append a free-form timeline entry (e.g. follower sync outcome or
   * a rejection audit line) without changing the position state.
   */
  appendTimeline(key: string, entry: LifecycleTimelineEntry): void {
    const existing = this.positions.get(key);
    if (!existing) return;
    existing.timeline.push(entry);
    existing.updatedAt = entry.at;
  }

  /**
   * Record a follower order that mirrors this master position. Called
   * automatically from the ExecutionEventRecorder subscription so the
   * lifecycle sync engine can locate follower orders later.
   */
  addFollowerOrder(key: string, follower: FollowerOrderLink): void {
    const existing = this.positions.get(key);
    if (!existing) return;
    // Replace by (followerAccountId + brokerOrderId) — a re-run of the
    // same follower on the same order should overwrite rather than
    // duplicate.
    const filtered = existing.followers.filter(
      (f) =>
        !(
          f.followerAccountId === follower.followerAccountId &&
          f.brokerOrderId === follower.brokerOrderId
        ),
    );
    existing.followers = [...filtered, follower];
    existing.updatedAt = follower.lastActionAt;
  }

  /**
   * Overwrite a follower link's last-action bookkeeping. Used by the
   * synchronization engine when it applies a MODIFY / CANCEL / EXIT
   * against a follower's broker order id.
   */
  updateFollowerLink(
    key: string,
    followerAccountId: string,
    brokerOrderId: string,
    patch: Partial<
      Pick<FollowerOrderLink, 'lastAction' | 'lastActionAt' | 'lastActionOk' | 'lastActionMessage'>
    >,
  ): void {
    const existing = this.positions.get(key);
    if (!existing) return;
    existing.followers = existing.followers.map((f) =>
      f.followerAccountId === followerAccountId &&
      f.brokerOrderId === brokerOrderId
        ? { ...f, ...patch }
        : f,
    );
    existing.updatedAt = new Date().toISOString();
  }

  // -------------------------------------------------------------------------
  // ExecutionEvent → follower correlation
  // -------------------------------------------------------------------------

  private correlateFollowersFromEvent(event: ExecutionEvent): void {
    // We can only correlate when the fan-out reports a master broker
    // order id (present on every real BROKER_POLL event because the
    // master watcher forwards it). Manual/synthetic events without an
    // orderId are recorded to execution_history but skipped here.
    const masterBrokerOrderId = event.masterBrokerOrderId;
    if (!masterBrokerOrderId) return;
    if (!isBrokerEnum(event.broker)) return;

    const key = this.buildKey(
      event.broker as Broker,
      event.masterAccountId,
      masterBrokerOrderId,
    );
    const record = this.positions.get(key);
    if (!record) {
      // Master position not tracked yet (edge case — event was fanned
      // out before ingestion recorded the master position). Skip
      // silently; the next lifecycle ingest will create the record.
      return;
    }

    for (const follower of event.followers) {
      if (follower.status !== 'SUCCESS') continue;
      const brokerOrderId = extractBrokerOrderId(follower.brokerResponse);
      if (!brokerOrderId) continue;
      if (!isBrokerEnum(follower.broker)) continue;

      const link: FollowerOrderLink = {
        followerAccountId: follower.followerAccountId,
        followerId: follower.followerId ?? null,
        followerEmail: follower.followerEmail ?? null,
        broker: follower.broker as Broker,
        brokerOrderId,
        followerSymbol: follower.followerSymbol,
        quantity: follower.quantity ?? null,
        createdAt: follower.startedAt,
        lastAction: 'PLACE',
        lastActionAt:
          follower.completedAt ?? follower.startedAt ?? new Date().toISOString(),
        lastActionOk: true,
        lastActionMessage: null,
      };
      this.addFollowerOrder(key, link);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function equalSignature(a: OrderSignature, b: OrderSignature): boolean {
  return (
    a.status === b.status &&
    a.filledQuantity === b.filledQuantity &&
    a.quantity === b.quantity &&
    a.price === b.price &&
    a.triggerPrice === b.triggerPrice &&
    a.brokerUpdatedAt === b.brokerUpdatedAt
  );
}

function isTerminal(state: PositionState): boolean {
  return (
    state === PositionState.CLOSED ||
    state === PositionState.CANCELLED ||
    state === PositionState.REJECTED
  );
}

function isBrokerEnum(value: string): boolean {
  return (Object.values(Broker) as string[]).includes(value);
}

/**
 * Same extraction rules the ExecutionHistoryService uses so a follower
 * broker order id lands consistently across the audit trail and the
 * lifecycle registry.
 */
function extractBrokerOrderId(response: unknown): string | null {
  if (!response || typeof response !== 'object') return null;
  const r = response as Record<string, unknown>;
  for (const key of ['order_id', 'orderId', 'orderid', 'id']) {
    const v = r[key];
    if (typeof v === 'string' && v.length > 0) return v;
    if (typeof v === 'number') return String(v);
  }
  return null;
}
