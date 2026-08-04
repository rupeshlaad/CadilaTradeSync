import { BadRequestException } from '@nestjs/common';
import { Broker } from '@prisma/client';

import { PositionRecord, PositionState } from '../position-lifecycle/lifecycle.types';

/**
 * Sprint 5.5.1 — Order-action validation rules.
 *
 * Pure functions over `PositionRecord`. Enforced BEFORE any broker
 * adapter call so an invalid admin action never reaches the exchange.
 *
 * Rules mirror the position lifecycle state-machine but are stricter
 * because admin-initiated Modify/Cancel/Exit have narrower semantics
 * than the free-form broker-side transitions the state machine also
 * accepts on master-watcher input.
 *
 *   - Modify   → PENDING or PARTIALLY_FILLED (filled/terminal disallowed).
 *   - Cancel   → PENDING or PARTIALLY_FILLED (open positions must EXIT).
 *   - Exit     → OPEN or PARTIALLY_FILLED    (pending orders must CANCEL).
 *
 * Broker eligibility mirrors the current adapter coverage: Zerodha
 * and Fyers implement `modifyOrder` / `cancelOrder` / `placeOrder`.
 * Shoonya is intentionally rejected here — it is only supported for
 * lifecycle detection today (see PositionSynchronizationService).
 */

const MODIFY_STATES: ReadonlySet<PositionState> = new Set([
  PositionState.PENDING,
  PositionState.PARTIALLY_FILLED,
]);

const CANCEL_STATES: ReadonlySet<PositionState> = new Set([
  PositionState.PENDING,
  PositionState.PARTIALLY_FILLED,
]);

const EXIT_STATES: ReadonlySet<PositionState> = new Set([
  PositionState.OPEN,
  PositionState.PARTIALLY_FILLED,
]);

const ACTIONABLE_BROKERS: ReadonlySet<Broker> = new Set<Broker>([
  Broker.ZERODHA,
  Broker.FYERS,
]);

function assertBrokerActionable(position: PositionRecord, action: string): void {
  if (!ACTIONABLE_BROKERS.has(position.broker)) {
    throw new BadRequestException(
      `Broker ${position.broker} does not support ${action} from the admin console yet`,
    );
  }
}

export function assertModifyAllowed(position: PositionRecord): void {
  assertBrokerActionable(position, 'modify');
  if (!MODIFY_STATES.has(position.state)) {
    throw new BadRequestException(
      `Cannot modify order — position is ${position.state}. ` +
        'Modify is only allowed for PENDING or PARTIALLY_FILLED orders.',
    );
  }
}

export function assertCancelAllowed(position: PositionRecord): void {
  assertBrokerActionable(position, 'cancel');
  if (!CANCEL_STATES.has(position.state)) {
    throw new BadRequestException(
      `Cannot cancel order — position is ${position.state}. ` +
        'Cancel is only allowed for PENDING or PARTIALLY_FILLED orders. ' +
        'Use Exit for OPEN positions.',
    );
  }
}

export function assertExitAllowed(position: PositionRecord): void {
  assertBrokerActionable(position, 'exit');
  if (!EXIT_STATES.has(position.state)) {
    throw new BadRequestException(
      `Cannot exit position — position is ${position.state}. ` +
        'Exit is only allowed for OPEN or PARTIALLY_FILLED positions.',
    );
  }
  if (position.filledQuantity <= 0 && position.quantity <= 0) {
    throw new BadRequestException(
      'Cannot exit position — no filled quantity to square off.',
    );
  }
}

/**
 * Broker-aware structural validation of a modify payload. Ensures the
 * combination of orderType + price + triggerPrice makes sense for the
 * target broker so a Kite/Fyers rejection is caught before we hit the
 * exchange. Applied on top of the DTO-level shape validation.
 */
export function validateBrokerModifyPayload(
  broker: Broker,
  payload: {
    quantity: number;
    price: number | null;
    triggerPrice: number | null;
    orderType: string | null;
  },
): void {
  const orderType = (payload.orderType ?? '').toUpperCase();

  if (payload.quantity !== null && payload.quantity <= 0) {
    throw new BadRequestException('Quantity must be a positive integer');
  }

  if ((orderType === 'LIMIT' || orderType === 'SL') && payload.price === null) {
    throw new BadRequestException(
      `${orderType} orders require a limit price`,
    );
  }
  if (
    (orderType === 'SL' || orderType === 'SL-M') &&
    payload.triggerPrice === null
  ) {
    throw new BadRequestException(
      `${orderType} orders require a trigger price`,
    );
  }

  if (broker === Broker.FYERS && orderType === 'MARKET' && payload.price) {
    // Fyers MARKET modify with a non-zero limit price is silently
    // ignored by the adapter — surface it clearly instead.
    throw new BadRequestException(
      'Fyers MARKET orders cannot carry a limit price on modify',
    );
  }
}
