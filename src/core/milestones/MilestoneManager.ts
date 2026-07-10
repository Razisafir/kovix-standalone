/**
 * MilestoneManager — Kovix 2.0 Phase 2.
 *
 * Owns the ordered list of milestones for a single `runMilestoneTask` run.
 * The manager is intentionally not a singleton — one instance per task, held
 * by the AgentLoop, discarded when the task finishes.
 *
 * Why a separate class (instead of inline state on AgentLoop)?
 *  - Single responsibility: the manager owns CRUD on the plan; the loop owns
 *    the LLM conversation. Easier to test in isolation.
 *  - Future hooks: progress emission, persistence, replanning all live here
 *    without bloating the loop.
 *
 * Concurrency note: the methods are synchronous because the AgentLoop drives
 * milestones sequentially. If we later parallelise, wrap state mutations in
 * a queue.
 */
import type { Milestone, MilestoneStatus, PlannedMilestone } from './types.js';

export class MilestoneManager {
  private milestones: Milestone[] = [];
  private nextId = 0;

  /**
   * Replace the entire plan. Existing milestones are discarded. IDs are
   * assigned as monotonic string indices ("0", "1", …) so they're stable
   * for the lifetime of this manager.
   */
  setPlan(planned: PlannedMilestone[]): void {
    this.nextId = 0;
    this.milestones = planned.map((p) => ({
      id: String(this.nextId++),
      title: p.title,
      description: p.description,
      status: 'PLANNED' satisfies MilestoneStatus,
    }));
  }

  /**
   * Update the status of a single milestone by id.
   * @throws if no milestone with that id exists.
   */
  updateStatus(id: string, status: MilestoneStatus): void {
    const m = this.milestones.find((x) => x.id === id);
    if (!m) {
      throw new Error(`MilestoneManager: unknown milestone id "${id}"`);
    }
    m.status = status;
  }

  /** Returns a shallow copy of the current plan. */
  getPlan(): Milestone[] {
    return this.milestones.map((m) => ({ ...m }));
  }

  /** Returns the first milestone with status PLANNED, or `undefined` if none. */
  getNextExecutable(): Milestone | undefined {
    return this.milestones.find((m) => m.status === 'PLANNED');
  }
}
