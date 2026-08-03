import { Broker } from '@prisma/client';
import { ExecutionState } from './execution-state';

/**
 * In-memory execution context for a running / paused strategy.
 *
 * This is deliberately NOT persisted in the database in Phase 1 — the
 * scheduler, worker and durable state store are out of scope for this
 * sprint. When the API process restarts, all contexts are lost and each
 * strategy resets to DRAFT (as reported by getExecutionStatus).
 */
export interface ExecutionContext {
  strategyId: string;
  masterAccountId: string;
  broker: Broker;
  status: ExecutionState;
  startedAt: string;
  lastHeartbeat: string;
  /**
   * Populated when the state machine enters ERROR so operators can see
   * why. Cleared on the next successful state change.
   */
  lastError?: string | null;
}
