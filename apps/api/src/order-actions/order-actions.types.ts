import type { FollowerSyncOutcome, PositionState } from '../position-lifecycle/lifecycle.types';

/**
 * Sprint 5.5.1 — Order Actions result envelope.
 *
 * Returned by the OrderActionsService for every Modify / Cancel / Exit
 * so the admin UI can render:
 *   - whether the lifecycle transition was accepted
 *   - the position's new state (source of truth for the badge)
 *   - the master broker's verbatim response
 *   - the follower-side sync outcomes attempted by
 *     PositionSynchronizationService as part of the same fan-out.
 */
export type OrderActionType = 'MODIFY' | 'CANCEL' | 'EXIT';

export interface OrderActionResult {
  action: OrderActionType;
  key: string;
  accepted: boolean;
  previousState: PositionState | null;
  nextState: PositionState | null;
  reason: string | null;
  brokerResponse: unknown;
  followerSync: FollowerSyncOutcome[];
}
