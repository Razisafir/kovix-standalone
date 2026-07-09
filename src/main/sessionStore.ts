/**
 * sessionStore — in-memory Build mode session state, shared across screens.
 *
 * Phase 1 kept refinement state (ideaText, priorTurns) in a tiny object
 * inside main.ts. Phase 2 extends this to track the full Build mode flow:
 *   idea → refinement → spec → spec approval → plan → pre-flight → execute → done
 *
 * This module is main-process only. The renderer never sees this state
 * directly — it asks for slices via IPC (kovix:session:get-state, etc.).
 *
 * PERSISTENCE
 * -----------
 * The session is in-memory only. If the user closes the window, the
 * session is lost. This matches Phase 1 behavior and is intentional for
 * Phase 2 — adding disk persistence for half-finished builds is a separate
 * feature (and a separate set of UX decisions about resumption). The
 * SETTINGS (provider/key/model) ARE persisted via settingsStore.ts; only
 * the build session itself is ephemeral.
 *
 * APPROVAL GATES
 * --------------
 * The spec and plan both have an "approved" flag. Once approved, the
 * session advances to the next stage and the previous stage becomes
 * immutable (the UI disables inline edits). This is the lock-in semantics
 * the user asked for: "Approve spec" locks it and routes to Plan stage.
 */

import type { RefinementSpec, RefinementTurn } from '../agent/refinement/refinementService.js';
import type { PlanMilestone } from '../agent/planning/planningService.js';

// ----------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------

export type BuildStage =
    | 'idea'         // typing an idea
    | 'refining'     // Q&A loop with the LLM
    | 'spec'         // spec shown, awaiting approval
    | 'plan'         // plan shown, awaiting approval (or generating)
    | 'preflight'    // pre-flight config screen
    | 'executing'    // agent running milestones
    | 'done';        // build complete

export type MilestonePauseMode =
    | 'every'        // stop at every milestone
    | 'major'        // stop only at major milestones
    | 'auto'         // full auto — no pauses (except verification failures)
    | 'custom';      // stop at user-picked milestone IDs

export interface PreflightConfig {
    pauseMode: MilestonePauseMode;
    /** For 'custom' mode: which milestone IDs to pause at. */
    customPauseIds: string[];
    /** Optional credit cap. 0 = no cap. */
    creditLimit: number;
    /** Whether to run verification after each milestone. Default true. */
    verifyAfterEach: boolean;
}

export interface MilestoneExecutionState {
    milestoneId: string;
    status: 'pending' | 'running' | 'paused' | 'completed' | 'skipped' | 'failed';
    /** Events emitted while running this milestone (truncated for UI). */
    events: Array<{ type: string; text: string; ts: number }>;
    /** Verification result, if run. */
    verificationPassed?: boolean;
    verificationOutput?: string;
    /** When this milestone started/ended. */
    startedAt?: number;
    endedAt?: number;
}

export interface BuildSession {
    // --- Stage tracking ---
    stage: BuildStage;

    // --- Refinement (Phase 1) ---
    ideaText: string;
    priorTurns: RefinementTurn[];

    // --- Spec (Phase 1 output, Phase 2 input) ---
    spec: RefinementSpec | null;
    specApprovedAt: number | null;

    // --- Plan (Phase 2) ---
    planSummary: string;
    milestones: PlanMilestone[];
    planApprovedAt: number | null;

    // --- Pre-flight (Phase 2) ---
    preflight: PreflightConfig | null;

    // --- Execution (Phase 2) ---
    execution: {
        milestoneStates: MilestoneExecutionState[];
        currentMilestoneId: string | null;
        totalCreditsUsed: number;
        startedAt: number | null;
        endedAt: number | null;
        abortRequested: boolean;
    };
}

// ----------------------------------------------------------------------
// Default / factory
// ----------------------------------------------------------------------

export function createEmptySession(): BuildSession {
    return {
        stage: 'idea',
        ideaText: '',
        priorTurns: [],
        spec: null,
        specApprovedAt: null,
        planSummary: '',
        milestones: [],
        planApprovedAt: null,
        preflight: null,
        execution: {
            milestoneStates: [],
            currentMilestoneId: null,
            totalCreditsUsed: 0,
            startedAt: null,
            endedAt: null,
            abortRequested: false,
        },
    };
}

export function defaultPreflightConfig(milestones: PlanMilestone[]): PreflightConfig {
    return {
        pauseMode: 'major',
        customPauseIds: milestones.filter(m => m.isMajor).map(m => m.id),
        creditLimit: 0,
        verifyAfterEach: true,
    };
}
