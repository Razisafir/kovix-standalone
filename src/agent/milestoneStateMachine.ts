/**
 * Execution state for the milestone-based agent loop.
 *
 * Ported from Kovix_2.0 src/vs/platform/construct/common/agent/milestoneStateMachine.ts
 * with NO logic changes — this file was pure types, no VS Code coupling.
 */

export enum ExecutionState {
    Idle = 'idle',
    Planning = 'planning',
    AwaitingApproval = 'awaiting_approval',
    Executing = 'executing',
    /** Harness is running a real check (test/build/typecheck) to confirm the agent's "done" claim. */
    Verifying = 'verifying',
    PausedAtMilestone = 'paused_at_milestone',
    Complete = 'complete',
    VerificationFailed = 'verification_failed',
    Error = 'error',
}

export interface IMilestone {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly index: number;
    readonly isMajor: boolean;
    readonly stepIndices: number[];
    readonly completed: boolean;
}

export interface ISelectablePlanStep {
    readonly index: number;
    readonly action: 'Read' | 'Create' | 'Edit' | 'Run';
    readonly target: string;
    readonly description: string;
    selected: boolean;
}

export interface IApprovedPlan {
    readonly task: string;
    readonly steps: ISelectablePlanStep[];
    readonly executionMode: string;
    readonly milestones: IMilestone[];
    readonly selectedMilestoneIds?: string[];
    readonly approved: boolean;
    readonly approvedAt: number;
}

export interface IPlanStep {
    index: number;
    action: 'Read' | 'Create' | 'Edit' | 'Run';
    target: string;
    description: string;
}

export interface IPlanResult {
    steps: IPlanStep[];
    summary: string;
    rawResponse: string;
}
