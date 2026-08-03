/**
 * Strategy execution lifecycle states.
 *
 * DRAFT   – strategy exists but has never been validated for execution.
 * READY   – validated successfully and eligible to be started.
 * RUNNING – actively executing (Phase 1: in-memory only, no orders).
 * PAUSED  – execution suspended by an operator, can resume.
 * STOPPED – execution ended; context is torn down.
 * ERROR   – validation or a runtime issue put the strategy into a fault
 *           state. The operator must stop (to clear) or re-validate.
 */
export enum ExecutionState {
  DRAFT = 'DRAFT',
  READY = 'READY',
  RUNNING = 'RUNNING',
  PAUSED = 'PAUSED',
  STOPPED = 'STOPPED',
  ERROR = 'ERROR',
}

/**
 * Allowed source → target transitions. A transition NOT listed here is
 * considered invalid and must be rejected with a 409 Conflict by the
 * service layer.
 *
 * Notes on shape:
 *  - DRAFT → READY only happens as the successful side-effect of
 *    validateStrategy(). Callers cannot "jump" to READY manually.
 *  - RUNNING → RUNNING is intentionally disallowed (duplicate start).
 *  - STOPPED → PAUSED is intentionally disallowed.
 *  - STOPPED → READY re-arms the strategy after a successful re-validation.
 *  - ERROR → STOPPED lets the operator clear the fault; ERROR → READY
 *    is reached via a fresh validateStrategy() call.
 */
export const VALID_TRANSITIONS: Readonly<Record<ExecutionState, ExecutionState[]>> = {
  [ExecutionState.DRAFT]: [ExecutionState.READY, ExecutionState.ERROR],
  [ExecutionState.READY]: [
    ExecutionState.RUNNING,
    ExecutionState.STOPPED,
    ExecutionState.ERROR,
  ],
  [ExecutionState.RUNNING]: [
    ExecutionState.PAUSED,
    ExecutionState.STOPPED,
    ExecutionState.ERROR,
  ],
  [ExecutionState.PAUSED]: [
    ExecutionState.RUNNING,
    ExecutionState.STOPPED,
    ExecutionState.ERROR,
  ],
  [ExecutionState.STOPPED]: [ExecutionState.READY, ExecutionState.ERROR],
  [ExecutionState.ERROR]: [ExecutionState.STOPPED, ExecutionState.READY],
};

export function isTransitionAllowed(
  from: ExecutionState,
  to: ExecutionState,
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}
