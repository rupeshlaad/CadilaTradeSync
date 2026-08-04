import { LifecycleEventType, PositionState } from './lifecycle.types';

/**
 * Sprint 5.3 — Position lifecycle state machine.
 *
 * Pure functions over `PositionState` × `LifecycleEventType`. This module
 * has no side-effects and no dependencies — every transition rule the
 * lifecycle manager and synchronization engine rely on is declared here.
 *
 * The rules are deliberately permissive on the input side (brokers do
 * emit strange sequences) but strict on terminal transitions:
 *   - Once CLOSED / CANCELLED / REJECTED, no further transitions.
 *   - PARTIAL_FILL / COMPLETE_FILL after CANCELLED / REJECTED are
 *     rejected as invalid and logged upstream.
 */

/** Legal target states for each observed lifecycle event. */
const RULES: Readonly<Record<LifecycleEventType, ReadonlyArray<PositionState>>> = {
  [LifecycleEventType.NEW]: [PositionState.PENDING],
  [LifecycleEventType.PARTIAL_FILL]: [PositionState.PARTIALLY_FILLED],
  [LifecycleEventType.COMPLETE_FILL]: [PositionState.OPEN],
  [LifecycleEventType.ORDER_MODIFY]: [
    PositionState.PENDING,
    PositionState.PARTIALLY_FILLED,
    PositionState.OPEN,
  ],
  [LifecycleEventType.STOP_LOSS_MODIFY]: [
    PositionState.PENDING,
    PositionState.PARTIALLY_FILLED,
    PositionState.OPEN,
  ],
  [LifecycleEventType.TARGET_MODIFY]: [
    PositionState.PENDING,
    PositionState.PARTIALLY_FILLED,
    PositionState.OPEN,
  ],
  [LifecycleEventType.CANCEL]: [PositionState.CANCELLED],
  [LifecycleEventType.EXIT]: [PositionState.EXITING],
  [LifecycleEventType.POSITION_CLOSED]: [PositionState.CLOSED],
  [LifecycleEventType.REJECT]: [PositionState.REJECTED],
};

/**
 * States that terminate the lifecycle. Once a position is in one of
 * these, no further transitions are legal.
 */
const TERMINAL: ReadonlySet<PositionState> = new Set<PositionState>([
  PositionState.CLOSED,
  PositionState.CANCELLED,
  PositionState.REJECTED,
]);

/**
 * States from which an ORDER_MODIFY / *_MODIFY does not make sense.
 * ORDER_MODIFY is always the modification of an open (not yet closed)
 * order, so terminal states plus EXITING are illegal sources.
 */
const NO_MODIFY_FROM: ReadonlySet<PositionState> = new Set<PositionState>([
  ...TERMINAL,
  PositionState.EXITING,
]);

export interface TransitionDecision {
  ok: boolean;
  nextState: PositionState | null;
  reason: string | null;
}

/**
 * Decide the next PositionState given the currently-tracked state and
 * the observed lifecycle event. Returns `ok=false` with a reason for
 * illegal transitions so the caller can log + skip.
 *
 * `current` may be `null` when a position is being tracked for the
 * first time; in that case only NEW / COMPLETE_FILL / PARTIAL_FILL /
 * REJECT are accepted as valid opening events. Anything else on an
 * unknown position is treated as a stale broker echo and ignored.
 */
export function decideTransition(
  current: PositionState | null,
  event: LifecycleEventType,
): TransitionDecision {
  const allowed = RULES[event];

  if (!current) {
    switch (event) {
      case LifecycleEventType.NEW:
        return { ok: true, nextState: PositionState.PENDING, reason: null };
      case LifecycleEventType.PARTIAL_FILL:
        return {
          ok: true,
          nextState: PositionState.PARTIALLY_FILLED,
          reason: null,
        };
      case LifecycleEventType.COMPLETE_FILL:
        return { ok: true, nextState: PositionState.OPEN, reason: null };
      case LifecycleEventType.REJECT:
        return { ok: true, nextState: PositionState.REJECTED, reason: null };
      case LifecycleEventType.CANCEL:
        return { ok: true, nextState: PositionState.CANCELLED, reason: null };
      default:
        return {
          ok: false,
          nextState: null,
          reason: `Cannot start position lifecycle from event ${event}`,
        };
    }
  }

  if (TERMINAL.has(current)) {
    return {
      ok: false,
      nextState: null,
      reason: `Position already terminal in state ${current}`,
    };
  }

  if (
    event === LifecycleEventType.ORDER_MODIFY ||
    event === LifecycleEventType.STOP_LOSS_MODIFY ||
    event === LifecycleEventType.TARGET_MODIFY
  ) {
    if (NO_MODIFY_FROM.has(current)) {
      return {
        ok: false,
        nextState: null,
        reason: `${event} illegal from state ${current}`,
      };
    }
    // Modification keeps the current state.
    return { ok: true, nextState: current, reason: null };
  }

  if (event === LifecycleEventType.PARTIAL_FILL) {
    if (current === PositionState.OPEN) {
      // Extra fill reported after we already believed the order was
      // fully filled — likely a stale broker echo. Ignore.
      return {
        ok: false,
        nextState: null,
        reason: 'PARTIAL_FILL after position already OPEN',
      };
    }
    return {
      ok: true,
      nextState: PositionState.PARTIALLY_FILLED,
      reason: null,
    };
  }

  if (event === LifecycleEventType.COMPLETE_FILL) {
    if (current === PositionState.OPEN) {
      return {
        ok: false,
        nextState: null,
        reason: 'Duplicate COMPLETE_FILL — position already OPEN',
      };
    }
    return { ok: true, nextState: PositionState.OPEN, reason: null };
  }

  if (event === LifecycleEventType.NEW) {
    if (current !== PositionState.PENDING) {
      return {
        ok: false,
        nextState: null,
        reason: `NEW illegal from state ${current}`,
      };
    }
    // Duplicate NEW for the same order — no-op.
    return { ok: true, nextState: current, reason: null };
  }

  if (event === LifecycleEventType.CANCEL) {
    if (current === PositionState.OPEN) {
      return {
        ok: false,
        nextState: null,
        reason: 'CANCEL illegal after position is OPEN — use EXIT',
      };
    }
    return { ok: true, nextState: PositionState.CANCELLED, reason: null };
  }

  if (event === LifecycleEventType.EXIT) {
    if (current !== PositionState.OPEN && current !== PositionState.PARTIALLY_FILLED) {
      return {
        ok: false,
        nextState: null,
        reason: `EXIT illegal from state ${current}`,
      };
    }
    return { ok: true, nextState: PositionState.EXITING, reason: null };
  }

  if (event === LifecycleEventType.POSITION_CLOSED) {
    if (
      current !== PositionState.EXITING &&
      current !== PositionState.OPEN &&
      current !== PositionState.PARTIALLY_FILLED
    ) {
      return {
        ok: false,
        nextState: null,
        reason: `POSITION_CLOSED illegal from state ${current}`,
      };
    }
    return { ok: true, nextState: PositionState.CLOSED, reason: null };
  }

  if (event === LifecycleEventType.REJECT) {
    if (current !== PositionState.PENDING) {
      return {
        ok: false,
        nextState: null,
        reason: `REJECT illegal from state ${current}`,
      };
    }
    return { ok: true, nextState: PositionState.REJECTED, reason: null };
  }

  // Defensive fallback — if we ever add a new event without extending
  // the switch above, treat it as an illegal transition rather than
  // silently accepting whatever RULES says.
  return {
    ok: false,
    nextState: allowed && allowed.length === 1 ? allowed[0] ?? null : null,
    reason: `Unhandled event ${event} from state ${current}`,
  };
}

export function isTerminal(state: PositionState): boolean {
  return TERMINAL.has(state);
}
