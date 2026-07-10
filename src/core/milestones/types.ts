/**
 * Milestone types — Kovix 2.0 Phase 2.
 *
 * A Milestone is a single, verifiable chunk of work that the Lead Agent
 * has decomposed a user task into. The MilestoneManager owns the ordered
 * list; the AgentLoop executes them one at a time.
 *
 * Lifecycle:  PLANNED → EXECUTING → VERIFIED
 *                          ↓
 *                        FAILED   (set if execution throws / hits max iters)
 *
 * `PLANNED` is the only "actionable" state — `getNextExecutable()` returns
 * the first PLANNED milestone. Once a milestone is EXECUTING/VERIFIED/FAILED,
 * it's never returned by `getNextExecutable()` again, so the outer loop in
 * `runMilestoneTask` naturally drains the queue.
 */
export const MilestoneStatus = {
  PLANNED: 'PLANNED',
  EXECUTING: 'EXECUTING',
  VERIFIED: 'VERIFIED',
  FAILED: 'FAILED',
} as const;

export type MilestoneStatus = (typeof MilestoneStatus)[keyof typeof MilestoneStatus];

export interface Milestone {
  /** Stable identifier. We use a monotonic index as a string ("0", "1", …). */
  id: string;
  title: string;
  description: string;
  status: MilestoneStatus;
}

/**
 * Shape the Lead Agent is asked to emit in the planning phase. It omits
 * `id` and `status` because those are assigned by the manager.
 */
export interface PlannedMilestone {
  title: string;
  description: string;
}
