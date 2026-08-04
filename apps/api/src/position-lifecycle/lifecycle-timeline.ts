import {
  LifecycleEvent,
  LifecycleEventType,
  LifecycleTimelineEntry,
  PositionRecord,
  PositionState,
} from './lifecycle.types';

/**
 * Sprint 5.3 — pure helpers that build & format lifecycle timeline
 * entries for a tracked position. No I/O, no state — the registry
 * calls these to append entries in a consistent shape.
 */

export function buildTransitionEntry(
  event: LifecycleEvent,
  previousState: PositionState | null,
  nextState: PositionState,
): LifecycleTimelineEntry {
  const at = event.brokerUpdatedAt ?? new Date().toISOString();
  const kind = event.type;
  const label = describeTransition(event, previousState, nextState);
  return {
    at,
    kind,
    label,
    details: {
      brokerOrderId: event.brokerOrderId,
      quantity: event.quantity,
      filledQuantity: event.filledQuantity,
      pendingQuantity: event.pendingQuantity,
      price: event.price,
      triggerPrice: event.triggerPrice,
      previousState,
      nextState,
      rawStatus: event.rawStatus,
      reason: event.reason,
    },
  };
}

export function buildFollowerSyncEntry(
  event: LifecycleEvent,
  action: 'MODIFY' | 'CANCEL' | 'EXIT',
  followerEmail: string | null,
  ok: boolean,
  reason: string | null,
): LifecycleTimelineEntry {
  return {
    at: new Date().toISOString(),
    kind: ok ? `FOLLOWER_${action}_OK` : `FOLLOWER_${action}_FAIL`,
    label: ok
      ? `Follower ${followerEmail ?? '—'} ${action.toLowerCase()} applied`
      : `Follower ${followerEmail ?? '—'} ${action.toLowerCase()} failed${
          reason ? `: ${reason}` : ''
        }`,
    details: {
      brokerOrderId: event.brokerOrderId,
      action,
      followerEmail,
      ok,
      reason,
    },
  };
}

export function buildRejectionEntry(
  reason: string,
  event?: LifecycleEvent | null,
): LifecycleTimelineEntry {
  return {
    at: new Date().toISOString(),
    kind: 'LIFECYCLE_REJECTED',
    label: `Lifecycle event rejected: ${reason}`,
    details: event
      ? {
          eventType: event.type,
          brokerOrderId: event.brokerOrderId,
        }
      : undefined,
  };
}

/**
 * Order timeline entries newest-first, matching the presentation used
 * by the Trade Monitor detail page.
 */
export function sortTimelineDesc(
  entries: ReadonlyArray<LifecycleTimelineEntry>,
): LifecycleTimelineEntry[] {
  return [...entries].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
}

/** Convenience — returns the most recent entry or null. */
export function latestEntry(
  record: Pick<PositionRecord, 'timeline'>,
): LifecycleTimelineEntry | null {
  if (record.timeline.length === 0) return null;
  return record.timeline[record.timeline.length - 1] ?? null;
}

function describeTransition(
  event: LifecycleEvent,
  previousState: PositionState | null,
  nextState: PositionState,
): string {
  const from = previousState ?? 'INIT';
  switch (event.type) {
    case LifecycleEventType.NEW:
      return `Order accepted (${event.side} ${event.symbol} x${event.quantity}) — ${from} → ${nextState}`;
    case LifecycleEventType.PARTIAL_FILL:
      return `Partial fill ${event.filledQuantity}/${event.quantity} @ ${event.price ?? '—'} — ${from} → ${nextState}`;
    case LifecycleEventType.COMPLETE_FILL:
      return `Fully filled ${event.filledQuantity}/${event.quantity} @ ${event.price ?? '—'} — ${from} → ${nextState}`;
    case LifecycleEventType.ORDER_MODIFY:
      return `Order modified (qty=${event.quantity}, price=${event.price ?? '—'}) — ${from} → ${nextState}`;
    case LifecycleEventType.STOP_LOSS_MODIFY:
      return `Stop-loss modified (trigger=${event.triggerPrice ?? '—'}) — ${from} → ${nextState}`;
    case LifecycleEventType.TARGET_MODIFY:
      return `Target modified (price=${event.price ?? '—'}) — ${from} → ${nextState}`;
    case LifecycleEventType.CANCEL:
      return `Order cancelled — ${from} → ${nextState}`;
    case LifecycleEventType.EXIT:
      return `Exit issued — ${from} → ${nextState}`;
    case LifecycleEventType.POSITION_CLOSED:
      return `Position closed — ${from} → ${nextState}`;
    case LifecycleEventType.REJECT:
      return `Order rejected${event.reason ? `: ${event.reason}` : ''} — ${from} → ${nextState}`;
    default:
      return `${event.type} — ${from} → ${nextState}`;
  }
}
