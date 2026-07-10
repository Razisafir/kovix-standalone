/**
 * LeadAgentService — coordination layer on top of the existing agent engine.
 *
 * DESIGN
 * ------
 * The lead agent iterates through the approved plan's milestones. For each
 * milestone, it:
 *
 *   1. Dispatches a FRESH AgentLoop instance (not an inner subTask on the
 *      same loop — a brand-new instance with clean conversation history).
 *      This is the key difference from AgentLoop.runWithApprovedPlan(),
 *      which reuses one loop and one conversation across all milestones.
 *      The fresh-instance-per-milestone design means each worker starts
 *      with a clean slate — no context bleed, no stale tool results from
 *      a previous milestone poisoning the next one.
 *
 *   2. The worker runs to completion (or pause per pre-flight config),
 *      using the SAME staging/approval/verification mechanism the agent
 *      loop always uses. The lead does NOT build a second execution path.
 *      It is purely a coordination layer.
 *
 *   3. The worker returns a structured WorkerReport: what was done, what
 *      files changed, whether the worker's own verification passed, the
 *      raw event log.
 *
 *   4. The lead reviews each worker's report BEFORE dispatching the next
 *      milestone. If the worker's verification failed (per Part 1's
 *      principles: stop and report, don't continue past a broken state),
 *      the lead STOPS and surfaces the failure clearly. It does NOT
 *      proceed to the next milestone on a broken foundation.
 *
 * SEQUENTIAL, NOT CONCURRENT
 * --------------------------
 * This pass is strictly sequential: one worker at a time. Concurrent
 * multi-agent execution is explicitly out of scope — too risky for the
 * timeline, and the staging layer is not designed for concurrent writes
 * to the same workspace. The lead waits for each worker to finish before
 * starting the next.
 *
 * EVENT CONTRACT
 * --------------
 * The lead yields LeadAgentEvent objects. The caller (IPC handler in
 * main.ts) forwards them to the renderer, which renders the lead/worker
 * visual structure on the Execute screen.
 *
 *   lead_started         — lead begins, total milestone count announced
 *   lead_reviewing       — lead is reviewing milestone N of M (before dispatch)
 *   worker_started       — fresh worker dispatched for milestone N
 *   worker_event         — passthrough of an AgentLoopEvent from the worker
 *                          (token, tool_start, tool_result, file_written, etc.)
 *   worker_completed     — worker finished, report attached
 *   lead_blocked         — worker verification failed, lead stopped
 *   lead_paused          — pre-flight config says pause at this milestone
 *   lead_resumed         — user resumed after a pause
 *   lead_complete        — all milestones done, final summary attached
 *   lead_error           — fatal error
 */

import { AgentLoop, type AgentLoopConfig } from '../agentLoop.js';
import type { AgentLoopEvent } from '../events.js';
import type {
    IConstructAIProvider,
} from '../llm/types.js';
import type { PlanMilestone } from '../planning/planningService.js';
import type { RefinementSpec } from '../refinement/refinementService.js';
import type { IMilestone, IApprovedPlan } from '../milestoneStateMachine.js';

// ----------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------

/** What a worker reports back to the lead after running one milestone. */
export interface WorkerReport {
    milestoneId: string;
    milestoneName: string;
    /** Final summary text the worker's LLM produced. */
    summary: string;
    /** Files the worker wrote (from file_written events). */
    filesChanged: string[];
    /** Whether the worker's own verification harness passed. */
    verificationPassed: boolean;
    /** Verification command output (truncated). */
    verificationOutput: string;
    /** True if verification was skipped (no command available). */
    verificationUnverified: boolean;
    /** Whether the worker hit a fatal error. */
    errored: boolean;
    /** Error message if errored. */
    errorMessage?: string;
    /** Raw event log (truncated to 500 events to bound memory). */
    eventLog: AgentLoopEvent[];
    /** Wall-clock duration in ms. */
    durationMs: number;
}

export type LeadAgentEvent =
    | { type: 'lead_started'; totalMilestones: number; milestones: Array<{ id: string; name: string }> }
    | { type: 'lead_reviewing'; milestoneIndex: number; totalMilestones: number; milestone: PlanMilestone }
    | { type: 'worker_started'; milestoneIndex: number; totalMilestones: number; milestone: PlanMilestone }
    | { type: 'worker_event'; milestoneId: string; event: AgentLoopEvent }
    | { type: 'worker_completed'; report: WorkerReport; milestoneIndex: number; totalMilestones: number }
    | { type: 'lead_blocked'; reason: string; failedReport: WorkerReport; milestoneIndex: number; totalMilestones: number }
    | { type: 'lead_paused'; milestone: PlanMilestone; milestoneIndex: number; totalMilestones: number }
    | { type: 'lead_resumed'; milestone: PlanMilestone; action: 'resume' | 'skip' }
    | { type: 'lead_complete'; summary: string; reports: WorkerReport[]; buildDir: string }
    | { type: 'lead_error'; text: string; recoverable: boolean };

export interface LeadAgentConfig {
    /** LLM provider factory — called once per worker to get a fresh provider. */
    createProvider: () => IConstructAIProvider;
    /** The approved plan's milestones (from planningService). */
    milestones: PlanMilestone[];
    /** The original idea text (for worker context). */
    ideaText: string;
    /** The approved spec (for worker context — what the milestone must satisfy). */
    spec: RefinementSpec;
    /** Per-build workspace directory. Workers write here. */
    buildDir: string;
    /**
     * Pause mode from pre-flight config. 'auto' = no pauses, 'every' = pause
     * after every milestone, 'major' = pause after major milestones,
     * 'custom' = pause at selected milestone IDs.
     */
    pauseMode: 'auto' | 'every' | 'major' | 'custom';
    /** For 'custom' pause mode: the milestone IDs to pause at. */
    customPauseIds?: string[];
    /** Approval callback — passed through to each worker's AgentLoop. */
    approveWrite?: AgentLoopConfig['approveWrite'];
    /** Interpreter command approval — passed through to each worker. */
    approveInterpreterCommand?: AgentLoopConfig['approveInterpreterCommand'];
    /** Logger. */
    log?: (message: string) => void;
}

// ----------------------------------------------------------------------
// LeadAgentService
// ----------------------------------------------------------------------

export class LeadAgentService {
    private _log: (message: string) => void;
    private _resumeResolver: ((action: 'resume' | 'skip') => void) | null = null;

    constructor(private config: LeadAgentConfig) {
        this._log = config.log ?? (() => { /* no-op */ });
    }

    /**
     * Run the lead agent. Iterates through milestones sequentially, dispatching
     * a fresh worker for each. Yields events as they happen.
     */
    async *run(signal?: AbortSignal): AsyncGenerator<LeadAgentEvent> {
        const { milestones, ideaText, spec, buildDir, pauseMode, customPauseIds } = this.config;
        this._log(`[lead] starting: ${milestones.length} milestones, buildDir=${buildDir}`);

        yield {
            type: 'lead_started',
            totalMilestones: milestones.length,
            milestones: milestones.map(m => ({ id: m.id, name: m.name })),
        };

        const reports: WorkerReport[] = [];

        for (let i = 0; i < milestones.length; i++) {
            if (signal?.aborted) {
                yield { type: 'lead_error', text: '[STOP] Aborted by user', recoverable: false };
                return;
            }

            const milestone = milestones[i];
            this._log(`[lead] milestone ${i + 1}/${milestones.length}: ${milestone.name}`);

            // Announce we're reviewing before dispatching.
            yield {
                type: 'lead_reviewing',
                milestoneIndex: i,
                totalMilestones: milestones.length,
                milestone,
            };

            // Build the worker's task description. The worker gets:
            //   - the original idea (for context)
            //   - the relevant spec requirements this milestone satisfies
            //   - the milestone's name + description
            //   - explicit instruction to focus ONLY on this milestone
            const satisfiesBlock = milestone.satisfies.length > 0
                ? milestone.satisfies.map((s: string) => '  - ' + s).join('\n')
                : '  (no specific spec requirements — supporting work)';
            const task = `You are a worker agent. Your scope is ONE milestone of a larger build. Do ONLY this milestone — do not start the next one.

ORIGINAL IDEA:
  ${ideaText}

APPROVED SPEC (for context — your milestone addresses the items listed below):
  must:
${spec.must.map((s: string) => '    - ' + s).join('\n')}
  doneCriteria:
${spec.doneCriteria.map((s: string) => '    - ' + s).join('\n')}

YOUR MILESTONE (${i + 1} of ${milestones.length}): ${milestone.name}
  description: ${milestone.description}
  satisfies:
${satisfiesBlock}

INSTRUCTIONS:
1. Complete ONLY this milestone. Do not start work that belongs to a later milestone.
2. Write real files to the workspace. Use the write_file tool.
3. After writing, verify by running a real command (npm test, npm run build, etc.) — reading the file back is NOT verification.
4. If you cannot complete this milestone because of a missing input or environment error, STOP and report the blockage. Do not guess silently.
5. When this milestone is done, summarize what you did in one or two sentences.`;

            // Dispatch a FRESH worker.
            yield {
                type: 'worker_started',
                milestoneIndex: i,
                totalMilestones: milestones.length,
                milestone,
            };

            const workerStart = Date.now();
            const workerProvider = this.config.createProvider();
            const workerLoop = new AgentLoop({
                aiProvider: workerProvider,
                workspaceRoot: buildDir,
                log: (msg: string) => this._log(`[worker-${milestone.id}] ` + msg),
                approveWrite: this.config.approveWrite,
                approveInterpreterCommand: this.config.approveInterpreterCommand,
                onlineMode: false,
            });

            // Drain the worker's event stream, forwarding passthrough events.
            const eventLog: AgentLoopEvent[] = [];
            let workerSummary = '';
            let workerErrored = false;
            let workerErrorMessage: string | undefined;
            let verificationPassed = true;
            let verificationOutput = '';
            let verificationUnverified = false;
            const filesChanged: string[] = [];

            try {
                const stream = workerLoop.run(task, signal);
                for await (const event of stream as AsyncIterable<AgentLoopEvent>) {
                    if (signal?.aborted) {
                        yield { type: 'lead_error', text: '[STOP] Aborted by user', recoverable: false };
                        return;
                    }
                    eventLog.push(event);
                    if (eventLog.length > 500) { eventLog.shift(); }

                    // Capture state from the event.
                    if (event.type === 'token') {
                        workerSummary += event.text;
                    } else if (event.type === 'file_written') {
                        filesChanged.push(event.filePath);
                    } else if (event.type === 'verification_result') {
                        verificationPassed = event.passed;
                        verificationOutput = event.output;
                        verificationUnverified = !!event.unverified;
                    } else if (event.type === 'complete') {
                        workerSummary = event.summary || workerSummary;
                    } else if (event.type === 'error' && !event.recoverable) {
                        workerErrored = true;
                        workerErrorMessage = event.text;
                    }

                    // Forward to caller as a passthrough event.
                    yield {
                        type: 'worker_event',
                        milestoneId: milestone.id,
                        event,
                    };
                }

                // After the worker's run() stream ends, run the verification
                // harness explicitly. workerLoop.run() does NOT call
                // runVerification() — only runWithApprovedPlan() does. Since
                // the lead uses run() (fresh loop per milestone), we must
                // invoke verifyNow() ourselves. This is the "verify after
                // every milestone" principle in action.
                if (!workerErrored) {
                    this._log(`[worker-${milestone.id}] running post-milestone verification`);
                    const vStream = workerLoop.verifyNow(signal);
                    for await (const vEvent of vStream as AsyncIterable<AgentLoopEvent>) {
                        eventLog.push(vEvent);
                        if (eventLog.length > 500) { eventLog.shift(); }
                        if (vEvent.type === 'verification_result') {
                            verificationPassed = vEvent.passed;
                            verificationOutput = vEvent.output;
                            verificationUnverified = !!vEvent.unverified;
                        }
                        yield {
                            type: 'worker_event',
                            milestoneId: milestone.id,
                            event: vEvent,
                        };
                    }
                }
            } catch (err) {
                workerErrored = true;
                workerErrorMessage = err instanceof Error ? err.message : String(err);
                this._log(`[worker-${milestone.id}] FATAL: ${workerErrorMessage}`);
            }

            const durationMs = Date.now() - workerStart;
            const report: WorkerReport = {
                milestoneId: milestone.id,
                milestoneName: milestone.name,
                summary: workerSummary.substring(0, 2000),
                filesChanged,
                verificationPassed,
                verificationOutput: verificationOutput.substring(0, 2000),
                verificationUnverified,
                errored: workerErrored,
                errorMessage: workerErrorMessage,
                eventLog,
                durationMs,
            };

            yield {
                type: 'worker_completed',
                report,
                milestoneIndex: i,
                totalMilestones: milestones.length,
            };
            reports.push(report);

            // LEAD REVIEW: if the worker's verification failed (or it errored),
            // STOP. Per Part 1 principles: don't continue past a broken state.
            // Exception: if verification was "unverified" (no command available),
            // we don't block — there's nothing to fail against.
            if (workerErrored) {
                yield {
                    type: 'lead_blocked',
                    reason: `Worker for milestone "${milestone.name}" hit a fatal error: ${workerErrorMessage ?? 'unknown error'}`,
                    failedReport: report,
                    milestoneIndex: i,
                    totalMilestones: milestones.length,
                };
                return;
            }
            if (!verificationPassed && !verificationUnverified) {
                yield {
                    type: 'lead_blocked',
                    reason: `Worker for milestone "${milestone.name}" declared complete, but verification FAILED. Per Part 1 principles, the lead stops rather than proceeding on a broken foundation. Verification output:\n${verificationOutput.substring(0, 800)}`,
                    failedReport: report,
                    milestoneIndex: i,
                    totalMilestones: milestones.length,
                };
                return;
            }

            // Pause handling per pre-flight config.
            const shouldPause = this._shouldPauseAt(milestone, pauseMode, customPauseIds);
            if (shouldPause) {
                this._log(`[lead] pausing at milestone ${milestone.name}`);
                yield {
                    type: 'lead_paused',
                    milestone,
                    milestoneIndex: i,
                    totalMilestones: milestones.length,
                };
                const action = await new Promise<'resume' | 'skip'>((resolve) => {
                    this._resumeResolver = resolve;
                });
                if (signal?.aborted) {
                    yield { type: 'lead_error', text: '[STOP] Aborted by user during pause', recoverable: false };
                    return;
                }
                yield { type: 'lead_resumed', milestone, action };
            }
        }

        // All milestones done.
        const summary = this._buildFinalSummary(reports);
        yield {
            type: 'lead_complete',
            summary,
            reports,
            buildDir,
        };
    }

    /** Resume from a lead pause. Only valid when paused. */
    resumeFromPause(): void {
        if (this._resumeResolver) {
            const resolver = this._resumeResolver;
            this._resumeResolver = null;
            resolver('resume');
        }
    }

    /** Skip the current paused milestone. */
    skipPausedMilestone(): void {
        if (this._resumeResolver) {
            const resolver = this._resumeResolver;
            this._resumeResolver = null;
            resolver('skip');
        }
    }

    // ------------------------------------------------------------------
    // Private helpers
    // ------------------------------------------------------------------

    private _shouldPauseAt(
        milestone: PlanMilestone,
        mode: 'auto' | 'every' | 'major' | 'custom',
        customIds?: string[],
    ): boolean {
        if (mode === 'auto') { return false; }
        if (mode === 'every') { return true; }
        if (mode === 'major') { return milestone.isMajor; }
        if (mode === 'custom') { return !!customIds && customIds.includes(milestone.id); }
        return false;
    }

    private _buildFinalSummary(reports: WorkerReport[]): string {
        const lines: string[] = [];
        lines.push(`Lead agent completed ${reports.length} milestone(s) sequentially.`);
        lines.push('');
        for (const r of reports) {
            const status = r.errored
                ? 'ERRORED'
                : (r.verificationUnverified ? 'unverified' : (r.verificationPassed ? 'verified' : 'FAILED'));
            lines.push(`[${r.milestoneId}] ${r.milestoneName} — ${status} (${r.durationMs}ms, ${r.filesChanged.length} file(s))`);
            if (r.summary) {
                lines.push('  summary: ' + r.summary.substring(0, 300));
            }
            if (r.filesChanged.length > 0) {
                lines.push('  files: ' + r.filesChanged.join(', '));
            }
        }
        return lines.join('\n');
    }
}

// ----------------------------------------------------------------------
// Helper: convert PlanMilestone[] to IApprovedPlan for legacy compat
// ----------------------------------------------------------------------

/**
 * If a caller wants to use the legacy milestoneExecutor path alongside the
 * lead agent (e.g. for feature flag comparison), this helper builds the
 * IApprovedPlan shape from PlanMilestone[]. The lead agent itself does NOT
 * use IApprovedPlan — it iterates PlanMilestone[] directly.
 */
export function buildApprovedPlanForLegacy(
    milestones: PlanMilestone[],
    ideaText: string,
    spec: RefinementSpec,
    approvedAt: number,
): IApprovedPlan {
    const steps = milestones.map((m, i) => ({
        index: i,
        action: m.type,
        target: m.name,
        description: m.description,
        selected: true,
    }));
    const iMilestones: IMilestone[] = milestones.map((m, i) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        index: i,
        isMajor: m.isMajor,
        stepIndices: [i],
        completed: false,
    }));
    return {
        task: ideaText + '\n\nApproved spec:\n' + JSON.stringify(spec, null, 2),
        steps,
        executionMode: 'auto',
        milestones: iMilestones,
        approved: true,
        approvedAt,
    };
}
