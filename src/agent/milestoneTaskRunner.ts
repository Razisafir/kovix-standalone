/**
 * MilestoneTaskRunner -- Phase 4 Step 2.
 *
 * A new EventEmitter-based runner that orchestrates an LLM through a
 * milestone-based plan-and-execute loop with an explicit verification gate.
 *
 * WHY THIS EXISTS ALONGSIDE AgentLoop:
 *   The existing `AgentLoop` (agentLoop.ts) is a generator-based runner
 *   designed around the streaming `IConstructAIProvider` interface. It already
 *   has planning + execution + harness-based verification (npm test / build /
 *   typecheck). Phase 4 adds TWO new capabilities that don't fit cleanly into
 *   that generator:
 *
 *     1. LLM-based verification -- a separate LLM call that judges whether the
 *        milestone's objective was actually met, by reviewing the conversation
 *        history. The harness in AgentLoop only checks "did the test command
 *        pass", which is useless for milestones that don't have a test
 *        command (e.g. "write a doc file").
 *
 *     2. Non-streaming provider interface -- some flows (verification,
 *        planning) just want "the model's full reply" without driving a UI
 *        stream. The new `LLMProvider` interface (from llmProviderAdapter.ts)
 *        is the right abstraction for those.
 *
 *   Rather than rewrite AgentLoop's 734-line generator (and risk breaking the
 *   streaming UI path), Phase 4 introduces this standalone runner that uses
 *   the new non-streaming interface end-to-end. It reuses the existing
 *   `TOOL_DEFINITIONS`, `executeTool`, `PendingChanges`, and security layer
 *   -- only the orchestration layer is new.
 *
 * EVENTS EMITTED:
 *   - 'plan_ready'             { milestones: Milestone[] }
 *   - 'milestone_started'      { milestone: Milestone }
 *   - 'tool_call'              { callId, name, args }
 *   - 'tool_result'            { callId, name, output, success }
 *   - 'verification_result'    { milestoneId, passed, reason }
 *   - 'milestone_verified'     { milestone: Milestone }
 *   - 'milestone_failed'       { milestone: Milestone, reason: string }
 *   - 'complete'               { milestones: Milestone[] }
 *   - 'error'                  { message: string }
 *
 * MILESTONE LIFECYCLE:
 *   PLANNED -> EXECUTING -> (verification gate) -> VERIFIED | FAILED
 *
 *   If a milestone FAILS verification, execution STOPS -- we do not proceed
 *   to the next milestone. The user (or the test harness) can inspect the
 *   final state via `getMilestones()`.
 */

import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import {
    LLMProvider,
    LLMMessage,
    LLMResponse,
    LLMToolCall,
    LLMToolSchema,
    toToolSchema,
} from './llmProviderAdapter.js';
import {
    TOOL_DEFINITIONS,
    executeTool,
    ToolContext,
} from './tools/index.js';
import { PendingChanges } from './staging/pendingChanges.js';
import { TerminalRateLimiter } from './security/index.js';
import type { IToolDefinition } from './llm/types.js';

// ----------------------------------------------------------------------
// Milestone state machine
// ----------------------------------------------------------------------

export const MilestoneStatus = {
    Planned: 'PLANNED',
    Executing: 'EXECUTING',
    Verified: 'VERIFIED',
    Failed: 'FAILED',
} as const;

export type MilestoneStatus = (typeof MilestoneStatus)[keyof typeof MilestoneStatus];

export interface Milestone {
    id: string;
    title: string;
    description: string;
    status: MilestoneStatus;
}

/** Shape emitted by the planning LLM (a list of these, as a JSON array). */
interface PlannedMilestone {
    title: string;
    description: string;
}

// ----------------------------------------------------------------------
// Runner config
// ----------------------------------------------------------------------

export interface MilestoneTaskRunnerConfig {
    /** Non-streaming LLM provider (use wrapProvider() to adapt a real one). */
    llm: LLMProvider;
    /** Workspace root -- all file tool calls are confined to this directory. */
    workspaceRoot: string;
    /** Logger; default is no-op. */
    log?: (message: string) => void;
    /** Cap on tool-loop iterations per milestone. Default 15. */
    maxIterations?: number;
    /**
     * Whether to auto-apply staged file writes during the tool loop. Default
     * true (matches AgentLoop's test-only auto-approve behavior when no
     * approveWrite callback is configured). Set to false if you want to drive
     * approvals via the staging layer + an external approver.
     */
    autoApplyWrites?: boolean;
}

// ----------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------

const DEFAULT_MAX_ITERATIONS = 15;

const PLANNING_SYSTEM_PROMPT = `You are a senior engineering lead. Decompose the user's task into an ordered list of milestones.

Return ONLY a JSON array. No prose, no markdown fences. Each element MUST have the shape:
  { "title": "<short imperative>", "description": "<one-sentence objective>" }

Rules:
- Each milestone must be independently verifiable.
- Prefer 2-5 milestones. Never more than 10.
- The milestones, executed in order, must complete the user's task.
- Do NOT include a final "verify" or "wrap up" milestone -- the system runs its own verification gate after each milestone.`;

const EXECUTION_SYSTEM_PROMPT = (milestone: Milestone): string =>
    `You are Kovix, an autonomous coding agent. You are executing a single milestone of a larger task.

Milestone: ${milestone.title}
Objective: ${milestone.description}

Use the provided tools to make progress. When the milestone's objective is met, stop calling tools and reply with a short natural-language summary of what you did. Do NOT claim completion unless you have actually done the work via the tools.`;

const VERIFICATION_SYSTEM_PROMPT = `You are a strict QA verifier. You will be shown the conversation history between an autonomous agent and its tools, covering a single milestone.

Your job: decide whether the milestone's objective was FULLY met by the work shown in the history.

Answer on the FIRST line with EXACTLY one word: YES or NO.
- If YES, you may stop. Do not add explanation.
- If NO, on subsequent lines give a one-sentence explanation of what is missing or incorrect.

Do not preface your answer. Do not add markdown.`;

// ----------------------------------------------------------------------
// Event payload types
// ----------------------------------------------------------------------

export interface PlanReadyPayload {
    milestones: Milestone[];
}
export interface MilestoneStartedPayload {
    milestone: Milestone;
}
export interface ToolCallPayload {
    callId: string;
    name: string;
    args: unknown;
}
export interface ToolResultPayload {
    callId: string;
    name: string;
    output: string;
    success: boolean;
}
export interface VerificationResultPayload {
    milestoneId: string;
    passed: boolean;
    reason: string;
}
export interface MilestoneVerifiedPayload {
    milestone: Milestone;
}
export interface MilestoneFailedPayload {
    milestone: Milestone;
    reason: string;
}
export interface CompletePayload {
    milestones: Milestone[];
}
export interface ErrorPayload {
    message: string;
}

// ----------------------------------------------------------------------
// Runner
// ----------------------------------------------------------------------

export class MilestoneTaskRunner extends EventEmitter {
    private readonly config: Required<Omit<MilestoneTaskRunnerConfig, 'llm'>> &
        { llm: LLMProvider };
    private readonly pendingChanges: PendingChanges;
    private readonly rateLimiter = new TerminalRateLimiter();
    private milestones: Milestone[] = [];

    constructor(config: MilestoneTaskRunnerConfig) {
        super();
        this.config = {
            llm: config.llm,
            workspaceRoot: config.workspaceRoot,
            log: config.log ?? (() => undefined),
            maxIterations: config.maxIterations ?? DEFAULT_MAX_ITERATIONS,
            autoApplyWrites: config.autoApplyWrites ?? true,
        };
        this.pendingChanges = new PendingChanges(config.workspaceRoot);
    }

    /** Snapshot of the current milestone plan and statuses. */
    getMilestones(): Milestone[] {
        return this.milestones.map(m => ({ ...m }));
    }

    // ------------------------------------------------------------------
    // Public entry point
    // ------------------------------------------------------------------

    /**
     * Plan + execute the user's task through the milestone pipeline.
     *
     * Returns the final milestone list (also available via getMilestones()).
     * Emits 'plan_ready', 'milestone_started', 'tool_call', 'tool_result',
     * 'verification_result', 'milestone_verified' / 'milestone_failed',
     * 'complete' (and 'error' on unrecoverable failure).
     */
    async runMilestoneTask(userPrompt: string): Promise<Milestone[]> {
        try {
            // Phase A: Planning -- LLM call WITHOUT tools
            this.config.log('[MilestoneTaskRunner] Phase A: planning');
            const planMessages: LLMMessage[] = [
                { role: 'system', content: PLANNING_SYSTEM_PROMPT },
                { role: 'user', content: userPrompt },
            ];
            const planResponse = await this.config.llm.chat(planMessages);
            const planned = parsePlannedMilestones(planResponse.content);
            this.milestones = planned.map((p, idx) => ({
                id: String(idx),
                title: p.title,
                description: p.description,
                status: MilestoneStatus.Planned,
            }));
            this.emit('plan_ready', { milestones: this.getMilestones() } satisfies PlanReadyPayload);
            this.config.log(`[MilestoneTaskRunner] Plan ready: ${this.milestones.length} milestone(s)`);

            // Phase B: Execute each milestone sequentially. We re-fetch the
            // milestone from this.milestones on each iteration because
            // executeOneMilestone mutates the entry in place (status change).
            for (let i = 0; i < this.milestones.length; i++) {
                const milestone = this.snapshot(this.milestones[i]!.id);
                if (milestone.status !== MilestoneStatus.Planned) {
                    // A previous failure stopped the pipeline.
                    break;
                }
                await this.executeOneMilestone(milestone);
                const after = this.snapshot(milestone.id);
                if (after.status === MilestoneStatus.Failed) {
                    this.config.log(`[MilestoneTaskRunner] Stopping pipeline: milestone ${milestone.id} FAILED`);
                    break;
                }
            }

            this.emit('complete', { milestones: this.getMilestones() } satisfies CompletePayload);
            return this.getMilestones();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.config.log(`[MilestoneTaskRunner] Error: ${message}`);
            this.emit('error', { message } satisfies ErrorPayload);
            return this.getMilestones();
        }
    }

    // ------------------------------------------------------------------
    // Per-milestone execution
    // ------------------------------------------------------------------

    private async executeOneMilestone(milestone: Milestone): Promise<void> {
        this.setMilestoneStatus(milestone.id, MilestoneStatus.Executing);
        this.emit('milestone_started', { milestone: this.snapshot(milestone.id) } satisfies MilestoneStartedPayload);
        this.config.log(`[MilestoneTaskRunner] Milestone ${milestone.id} EXECUTING: ${milestone.title}`);

        const tools = this.getToolSchemas();
        const history: LLMMessage[] = [
            { role: 'system', content: EXECUTION_SYSTEM_PROMPT(this.snapshot(milestone.id)) },
            { role: 'user', content: `Begin executing milestone: ${milestone.title}` },
        ];

        try {
            await this.runToolLoop(milestone, history, tools);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.setMilestoneStatus(milestone.id, MilestoneStatus.Failed);
            this.emit('milestone_failed', {
                milestone: this.snapshot(milestone.id),
                reason: `Tool loop threw: ${message}`,
            } satisfies MilestoneFailedPayload);
            return;
        }

        // Verification gate
        const verification = await this.verifyMilestone(this.snapshot(milestone.id), history);
        this.emit('verification_result', {
            milestoneId: milestone.id,
            passed: verification.passed,
            reason: verification.reason,
        } satisfies VerificationResultPayload);

        if (verification.passed) {
            this.setMilestoneStatus(milestone.id, MilestoneStatus.Verified);
            this.emit('milestone_verified', {
                milestone: this.snapshot(milestone.id),
            } satisfies MilestoneVerifiedPayload);
            this.config.log(`[MilestoneTaskRunner] Milestone ${milestone.id} VERIFIED`);
        } else {
            this.setMilestoneStatus(milestone.id, MilestoneStatus.Failed);
            this.emit('milestone_failed', {
                milestone: this.snapshot(milestone.id),
                reason: verification.reason,
            } satisfies MilestoneFailedPayload);
            this.config.log(`[MilestoneTaskRunner] Milestone ${milestone.id} FAILED: ${verification.reason}`);
        }
    }

    /**
     * Bounded tool loop. Calls the LLM, executes any tool_calls, feeds the
     * results back, repeats -- until the model stops calling tools or we hit
     * maxIterations.
     */
    private async runToolLoop(
        _milestone: Milestone,
        history: LLMMessage[],
        tools: LLMToolSchema[],
    ): Promise<void> {
        for (let iter = 0; iter < this.config.maxIterations; iter++) {
            const response = await this.config.llm.chat(history, tools);

            // Record the assistant turn (with any tool_calls).
            const assistantMsg: LLMMessage = {
                role: 'assistant',
                content: response.content,
            };
            if (response.tool_calls && response.tool_calls.length > 0) {
                assistantMsg.tool_calls = response.tool_calls;
            }
            history.push(assistantMsg);

            // No tool calls -> the model declared the milestone complete.
            if (!response.tool_calls || response.tool_calls.length === 0) {
                this.config.log(`[MilestoneTaskRunner] Iteration ${iter}: model stopped (stop_reason=${response.stop_reason})`);
                return;
            }

            // Execute each tool call and feed results back.
            for (const call of response.tool_calls) {
                const parsedArgs = safeParseArgs(call.function.arguments);
                this.emit('tool_call', {
                    callId: call.id,
                    name: call.function.name,
                    args: parsedArgs,
                } satisfies ToolCallPayload);

                const output = await this.executeOneToolCall(call, parsedArgs);

                this.emit('tool_result', {
                    callId: call.id,
                    name: call.function.name,
                    output: output.output,
                    success: output.success,
                } satisfies ToolResultPayload);

                history.push({
                    role: 'tool',
                    content: output.output,
                    tool_call_id: call.id,
                    name: call.function.name,
                });
            }
        }
        // Hit the iteration cap -- treat as completion of the loop; the
        // verification gate will judge whether the work was actually done.
        this.config.log(`[MilestoneTaskRunner] Hit maxIterations=${this.config.maxIterations}; proceeding to verification`);
    }

    // ------------------------------------------------------------------
    // Verification gate (Phase 4 Step 2)
    // ------------------------------------------------------------------

    /**
     * Make a separate LLM call (no tools) that reviews the conversation
     * history and judges whether the milestone was completed.
     *
     * Returns { passed: true } when the verifier's reply starts with "YES".
     * Returns { passed: false, reason } otherwise (the reason is the
     * verifier's full reply, which by spec contains a one-sentence
     * explanation after the "NO").
     */
    private async verifyMilestone(
        milestone: Milestone,
        history: LLMMessage[],
    ): Promise<{ passed: boolean; reason: string }> {
        this.config.log(`[MilestoneTaskRunner] Verifying milestone ${milestone.id}`);

        // Build a compact transcript so the verifier sees the work without
        // the (potentially huge) tool schemas / system prompts.
        const transcript: LLMMessage[] = [
            { role: 'system', content: VERIFICATION_SYSTEM_PROMPT },
            {
                role: 'user',
                content:
                    `Milestone title: ${milestone.title}\n` +
                    `Milestone objective: ${milestone.description}\n\n` +
                    `Conversation transcript (agent + tool results):\n` +
                    renderTranscript(history),
            },
        ];

        const response = await this.config.llm.chat(transcript);
        const text = response.content.trim();
        const firstLine = text.split('\n')[0]?.trim().toUpperCase() ?? '';

        if (firstLine === 'YES' || firstLine.startsWith('YES')) {
            return { passed: true, reason: 'YES' };
        }
        return { passed: false, reason: text };
    }

    // ------------------------------------------------------------------
    // Tool execution
    // ------------------------------------------------------------------

    private getToolSchemas(): LLMToolSchema[] {
        return TOOL_DEFINITIONS.map(toToolSchema);
    }

    private getToolContext(): ToolContext {
        return {
            workspaceRoot: this.config.workspaceRoot,
            pendingChanges: this.pendingChanges,
            rateLimiter: this.rateLimiter,
            log: (msg: string) => this.config.log(msg),
            onlineMode: false,
        };
    }

    private async executeOneToolCall(
        call: LLMToolCall,
        parsedArgs: unknown,
    ): Promise<{ output: string; success: boolean }> {
        const args = (parsedArgs ?? {}) as Record<string, unknown>;
        const ctx = this.getToolContext();
        const result = await executeTool(call.function.name, args, ctx, false);

        // If this was a write_file / edit_file and the runner is in
        // autoApplyWrites mode, flush the staged change to disk now.
        if (
            this.config.autoApplyWrites &&
            (call.function.name === 'write_file' || call.function.name === 'edit_file') &&
            result.success
        ) {
            const pathArg = typeof args.path === 'string' ? args.path : '';
            if (pathArg) {
                try {
                    await this.pendingChanges.applyStagedChange(pathArg);
                    this.config.log(`[MilestoneTaskRunner] Auto-applied staged write: ${pathArg}`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    return {
                        output: `Error applying staged change to ${pathArg}: ${msg}`,
                        success: false,
                    };
                }
            }
        }
        return { output: result.output, success: result.success };
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    private setMilestoneStatus(id: string, status: MilestoneStatus): void {
        const m = this.milestones.find(x => x.id === id);
        if (m) {
            m.status = status;
        }
    }

    private snapshot(id: string): Milestone {
        const m = this.milestones.find(x => x.id === id);
        if (!m) {
            throw new Error(`Milestone not found: ${id}`);
        }
        return { ...m };
    }
}

// ----------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ----------------------------------------------------------------------

/**
 * Parse the planning LLM's reply into a list of PlannedMilestone objects.
 *
 * Tolerant of:
 *   - Markdown code fences (```json ... ```)
 *   - Prose wrapper around the JSON array ("Sure, here's the plan: [...]")
 *   - Single object instead of array (treated as a 1-element plan)
 *
 * Drops elements that don't match the { title, description } shape rather
 * than failing the whole parse.
 */
export function parsePlannedMilestones(raw: string): PlannedMilestone[] {
    let text = raw.trim();
    if (!text) return [];

    // Strip markdown code fences.
    const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch) {
        text = fenceMatch[1].trim();
    }

    // Try a direct JSON parse first.
    let parsed: unknown = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        // Fall through to array extraction.
    }

    // If direct parse failed, extract the first [...] block.
    if (parsed === null) {
        const arrayMatch = text.match(/\[[\s\S]*\]/);
        if (arrayMatch) {
            try {
                parsed = JSON.parse(arrayMatch[0]);
            } catch {
                parsed = null;
            }
        }
    }

    // If still null, try a single object.
    if (parsed === null) {
        const objMatch = text.match(/\{[\s\S]*\}/);
        if (objMatch) {
            try {
                parsed = JSON.parse(objMatch[0]);
            } catch {
                parsed = null;
            }
        }
    }

    if (parsed === null) {
        return [];
    }

    // Normalize to array.
    const arr: unknown[] = Array.isArray(parsed) ? parsed : [parsed];

    const result: PlannedMilestone[] = [];
    for (const el of arr) {
        if (
            el &&
            typeof el === 'object' &&
            'title' in el &&
            'description' in el &&
            typeof (el as { title: unknown }).title === 'string' &&
            typeof (el as { description: unknown }).description === 'string'
        ) {
            const e = el as { title: string; description: string };
            result.push({ title: e.title, description: e.description });
        }
    }
    return result;
}

function safeParseArgs(argsJson: string): unknown {
    try {
        return JSON.parse(argsJson);
    } catch {
        return {};
    }
}

function renderTranscript(history: LLMMessage[]): string {
    const lines: string[] = [];
    for (const msg of history) {
        if (msg.role === 'system') continue;
        if (msg.role === 'user') {
            lines.push(`[USER] ${msg.content}`);
        } else if (msg.role === 'assistant') {
            const toolPart = msg.tool_calls && msg.tool_calls.length > 0
                ? ` (called tools: ${msg.tool_calls.map(t => t.function.name).join(', ')})`
                : '';
            lines.push(`[ASSISTANT] ${msg.content}${toolPart}`);
        } else if (msg.role === 'tool') {
            const name = msg.name ?? 'unknown';
            const preview = msg.content.length > 400
                ? msg.content.slice(0, 400) + ' ... (truncated)'
                : msg.content;
            lines.push(`[TOOL ${name}] ${preview}`);
        }
    }
    return lines.join('\n');
}

// ----------------------------------------------------------------------
// Re-export the adapter bits consumers will want alongside this runner
// ----------------------------------------------------------------------

export {
    wrapProvider,
    toToolSchema,
} from './llmProviderAdapter.js';
export type {
    LLMProvider,
    LLMMessage,
    LLMResponse,
    LLMToolCall,
    LLMToolSchema,
} from './llmProviderAdapter.js';

export type { IToolDefinition } from './llm/types.js';
export { TOOL_DEFINITIONS, executeTool } from './tools/index.js';
export type { ToolContext, ToolResult } from './tools/index.js';
export { PendingChanges } from './staging/pendingChanges.js';

// path/fs imports above are used by callers wiring their own tool contexts;
// silence unused-import lint inside this module if not otherwise used.
void path;
void fs;
