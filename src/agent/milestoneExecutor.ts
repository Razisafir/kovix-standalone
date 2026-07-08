/**
 * milestoneExecutor -- extracted helper.
 *
 * Ported from Kovix_2.0 src/vs/platform/construct/common/agent/milestoneExecutor.ts
 * with NO logic changes — only import paths updated to the new layout.
 *
 * The milestone-iteration + pause/resume logic for runWithApprovedPlan(),
 * extracted as a pure-ish generator function that takes its collaborators
 * as parameters.
 */

import { IApprovedPlan, IMilestone, ISelectablePlanStep } from './milestoneStateMachine.js';
import { AgentLoopEvent } from './events.js';

const CONFIG_FILE_PATTERNS: readonly RegExp[] = [
    /(^|\/)package\.json$/,
    /(^|\/)tsconfig\.json$/,
    /(^|\/)tsconfig\..+\.json$/,
    /(^|\/)\.env/,
    /(^|\/)docker-compose/,
    /(^|\/)Dockerfile/,
    /(^|\/)\.gitignore$/,
    /(^|\/)Cargo\.toml$/,
    /(^|\/)go\.mod$/,
    /(^|\/)go\.sum$/,
    /(^|\/)pom\.xml$/,
    /(^|\/)build\.gradle/,
    /(^|\/)settings\.json$/,
    /(^|\/)launch\.json$/,
    /(^|\/)extensions\.json$/,
    /(^|\/)Makefile$/,
    /(^|\/)CMakeLists\.txt$/,
    /(^|\/)\.eslintrc/,
    /(^|\/)\.prettierrc/,
    /(^|\/)webpack\.config/,
    /(^|\/)vite\.config/,
    /(^|\/)next\.config/,
];

function isMajorStep(step: ISelectablePlanStep): boolean {
    if (step.action === 'Create') { return true; }
    if (step.action === 'Run') { return true; }
    if (step.action === 'Edit' && CONFIG_FILE_PATTERNS.some(p => p.test(step.target))) { return true; }
    return false;
}

export type ExecuteSubTaskFn = (
    subTask: string,
    signal?: AbortSignal,
) => AsyncGenerator<AgentLoopEvent>;

export type RunVerificationFn = (
    signal?: AbortSignal,
) => AsyncGenerator<AgentLoopEvent>;

export type AwaitResumeFn = (milestone: IMilestone) => Promise<'resume' | 'skip'>;

export interface IMilestoneExecutorOptions {
    approvedPlan: IApprovedPlan;
    executeSubTask: ExecuteSubTaskFn;
    runVerification: RunVerificationFn;
    awaitResume: AwaitResumeFn;
    signal?: AbortSignal;
    log?: (message: string) => void;
}

export async function* executeMilestonesWithPauses(
    options: IMilestoneExecutorOptions,
): AsyncGenerator<AgentLoopEvent> {
    const { approvedPlan, executeSubTask, runVerification, awaitResume, signal, log } = options;

    const pauseMode = approvedPlan.executionMode ?? 'auto';
    const selectedPauseIds = new Set(approvedPlan.selectedMilestoneIds ?? []);

    const shouldPauseAt = (milestone: IMilestone): boolean => {
        if (pauseMode === 'every_milestone') { return true; }
        if (pauseMode === 'major_milestone') {
            if (milestone.isMajor) { return true; }
            const milestoneStepIndices = new Set(milestone.stepIndices);
            const steps = approvedPlan.steps.filter(
                (s, idx) => s.selected && milestoneStepIndices.has(idx),
            );
            return steps.some(step => isMajorStep(step));
        }
        if (pauseMode === 'selective' && selectedPauseIds.has(milestone.id)) { return true; }
        return false;
    };

    let aggregatedSummary = '';

    for (let mi = 0; mi < approvedPlan.milestones.length; mi++) {
        const milestone = approvedPlan.milestones[mi];

        if (signal?.aborted) {
            yield { type: 'error', text: '[STOP] Stopped by user', recoverable: false };
            return;
        }

        log?.(`[MilestoneExecutor] Milestone ${mi + 1}/${approvedPlan.milestones.length} reached: ${milestone.name}`);
        yield { type: 'milestone_reached', milestone };

        const milestoneStepIndices = new Set(milestone.stepIndices);
        const milestoneSteps = approvedPlan.steps
            .filter((s, idx) => s.selected && milestoneStepIndices.has(idx));

        if (milestoneSteps.length === 0) {
            log?.(`[MilestoneExecutor] Milestone ${milestone.name} has no selected steps, skipping`);
            aggregatedSummary += `\n[Milestone ${milestone.name}: no selected steps]\n`;
        } else {
            const stepList = milestoneSteps.map(s => `${s.action}: ${s.target}`).join('\n');
            const subTask = `${approvedPlan.task}\n\nMilestone ${mi + 1}: ${milestone.name}\nExecute these specific steps:\n${stepList}`;

            let milestoneSummary = '';
            for await (const event of executeSubTask(subTask, signal)) {
                yield event;
                if (event.type === 'token') {
                    milestoneSummary += event.text;
                } else if (event.type === 'error' && !event.recoverable) {
                    return;
                }
            }

            aggregatedSummary += `\n[Milestone ${milestone.name}]\n${milestoneSummary}`;

            let verificationFailed = false;
            for await (const vEvent of runVerification(signal)) {
                yield vEvent;
                if (vEvent.type === 'verification_result' && !vEvent.passed) {
                    verificationFailed = true;
                    log?.(`[MilestoneExecutor] Milestone ${milestone.name} verification failed`);
                    yield {
                        type: 'error',
                        text: `[Verification Failed] Milestone '${milestone.name}' declared complete, but the harness check returned non-zero.\n${vEvent.output.substring(0, 800)}`,
                        recoverable: true,
                    };
                }
            }

            const mustPause = verificationFailed || shouldPauseAt(milestone);
            if (mustPause) {
                log?.(`[MilestoneExecutor] Paused at milestone: ${milestone.name} (verificationFailed=${verificationFailed})`);
                yield { type: 'milestone_paused', milestone };

                const resumeAction = await awaitResume(milestone);

                if (signal?.aborted) {
                    yield { type: 'error', text: '[STOP] Stopped by user during milestone pause', recoverable: false };
                    return;
                }

                if (resumeAction === 'skip') {
                    log?.(`[MilestoneExecutor] Milestone ${milestone.name} SKIPPED by user (not completed)`);
                    aggregatedSummary += `\n[Milestone ${milestone.name}: SKIPPED by user -- not completed]\n`;
                    yield { type: 'milestone_skipped', milestone };
                    continue;
                }

                yield { type: 'milestone_resumed', milestone };
            }
        }

        yield { type: 'milestone_completed', milestone };
        log?.(`[MilestoneExecutor] Milestone ${milestone.name} completed`);
    }

    yield { type: 'complete', summary: aggregatedSummary || 'Task completed.' };
}
