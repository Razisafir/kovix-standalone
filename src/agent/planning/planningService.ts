/**
 * PlanningService — Build mode Phase 2: approved spec → milestone plan.
 *
 * CONTRACT
 * --------
 * Input  : { spec, ideaText }
 * Output : { milestones: PlanMilestone[] }
 *
 * The UI calls this ONCE after the user approves the spec. The service makes
 * a single LLM call (with the `emit_plan` tool) that produces a structured
 * list of milestones. Each milestone references which spec requirement it
 * satisfies, has an estimated credit cost, a type (Read/Create/Edit/Run),
 * and a major/minor flag.
 *
 * STRUCTURED OUTPUT
 * -----------------
 * Like refinementService, the "plan" is delivered via a tool call
 * (`emit_plan`), NOT by parsing prose. If the LLM emits text only, we retry
 * with a correction hint. This is the contract the user asked for: real
 * structured output, not placeholder text.
 *
 * PROVIDER REUSE
 * --------------
 * This service does NOT make HTTP calls directly. It calls `provider.chat()`
 * — the same IConstructAIProvider interface the agent loop uses. So any
 * provider created via `createProvider()` works here with zero additional
 * wiring. There is no second LLM-calling path.
 *
 * MILESTONE SHAPE
 * ---------------
 * The emitted plan is a flat list of milestones. Each milestone has:
 *   - id          : stable string ID (m1, m2, ...)
 *   - name        : short human-readable label
 *   - description : 1-2 sentence explanation of what this milestone accomplishes
 *   - satisfies   : array of spec requirement strings this milestone addresses
 *                   (drawn from the spec's must/should/doneCriteria arrays)
 *   - estimatedCredits : rough token-cost estimate (integer)
 *   - type        : 'Read' | 'Create' | 'Edit' | 'Run' — primary action kind
 *   - isMajor     : boolean — true for milestones that should pause in
 *                   "stop at major" mode (creates, runs, config edits)
 *
 * The milestone list is what the Pre-flight screen configures pausing for
 * and what the Execute screen iterates over.
 */

import type {
    IConstructAIProvider,
    IChatMessage,
    IToolDefinition,
    AIStreamEvent,
} from '../llm/types.js';
import type { RefinementSpec } from '../refinement/refinementService.js';
import { principlesBlock } from '../agentPrinciples.js';

// ----------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------

export type MilestoneType = 'Read' | 'Create' | 'Edit' | 'Run';

export interface PlanMilestone {
    /** Stable ID — m1, m2, m3, ... Used by Pre-flight "custom picks" mode. */
    id: string;
    /** Short human-readable label, e.g. "Scaffold project structure". */
    name: string;
    /** 1-2 sentence explanation of what this milestone does and why. */
    description: string;
    /**
     * Spec requirements this milestone satisfies. Each entry should match
     * (case-insensitive substring) an entry from the spec's must/should/
     * doneCriteria arrays. Used by the Execute screen to show coverage.
     */
    satisfies: string[];
    /** Rough token-cost estimate. Integer; 100-500 typical per milestone. */
    estimatedCredits: number;
    /** Primary action kind. Determines icon + whether it's "major". */
    type: MilestoneType;
    /** True for milestones that pause in "stop at major" mode.
     *  Derived from type: Create/Run are always major; Edit on config files
     *  is major. The LLM can override by setting isMajor explicitly. */
    isMajor: boolean;
}

export interface PlanResult {
    milestones: PlanMilestone[];
    /** The LLM's prose summary of the plan, for display in the UI. */
    summary: string;
}

export interface PlanningServiceConfig {
    /** The LLM provider — must come from createProvider(). */
    aiProvider: IConstructAIProvider;
    /** Max tokens for the LLM response. Default 4096 — plans can be long. */
    maxTokens?: number;
    /** Temperature. Default 0.2 — deterministic planning. */
    temperature?: number;
    /** Logger. Default: no-op. */
    log?: (message: string) => void;
}

// ----------------------------------------------------------------------
// The emit_plan tool definition
// ----------------------------------------------------------------------

const EMIT_PLAN_TOOL_NAME = 'emit_plan';

function buildEmitPlanTool(): IToolDefinition {
    return {
        name: EMIT_PLAN_TOOL_NAME,
        description:
            'Emit the milestone plan for this build. Call this ONCE after analyzing the spec. The plan is a flat ordered list of milestones the agent will execute. Each milestone should be a coherent unit of work (typically 1-3 file operations or one verification step). Order milestones so that foundational work (scaffolding, config) comes before feature work, and verification comes last.',
        inputSchema: {
            type: 'object',
            properties: {
                summary: {
                    type: 'string',
                    description: 'A 1-2 sentence prose summary of the overall plan, for display in the UI.',
                },
                milestones: {
                    type: 'array',
                    description: 'Ordered list of milestones. The agent will execute these in order, pausing at major milestones if configured.',
                    items: {
                        type: 'object',
                        properties: {
                            name: {
                                type: 'string',
                                description: 'Short label, e.g. "Scaffold project structure". Imperative mood.',
                            },
                            description: {
                                type: 'string',
                                description: '1-2 sentences explaining what this milestone does and why.',
                            },
                            satisfies: {
                                type: 'array',
                                items: { type: 'string' },
                                description: 'Spec requirements this milestone addresses. Copy the exact text from the spec\'s must/should/doneCriteria arrays.',
                            },
                            estimatedCredits: {
                                type: 'number',
                                description: 'Rough token-cost estimate. 100-500 typical per milestone.',
                            },
                            type: {
                                type: 'string',
                                enum: ['Read', 'Create', 'Edit', 'Run'],
                                description: 'Primary action kind: Read (explore), Create (new files), Edit (modify existing), Run (execute/verify).',
                            },
                            isMajor: {
                                type: 'boolean',
                                description: 'True for milestones that should pause in "stop at major" mode. Create/Run are typically major; Read is typically not.',
                            },
                        },
                        required: ['name', 'description', 'satisfies', 'estimatedCredits', 'type', 'isMajor'],
                    },
                },
            },
            required: ['summary', 'milestones'],
        },
    };
}

// ----------------------------------------------------------------------
// System prompt
// ----------------------------------------------------------------------

function buildSystemPrompt(spec: RefinementSpec, ideaText: string): string {
    const specBlock = `APPROVED SPEC (this is the contract — the plan must cover every "must" and "doneCriteria" item):
  must:
${spec.must.map(s => '    - ' + s).join('\n')}
  should:
${spec.should.map(s => '    - ' + s).join('\n')}
  wont:
${spec.wont.map(s => '    - ' + s).join('\n')}
  doneCriteria:
${spec.doneCriteria.map(s => '    - ' + s).join('\n')}`;

    return `You are the Build mode planning assistant for Kovix, an agent-first desktop app.

Your ONE job: turn an approved spec into a structured milestone plan that an autonomous agent will execute.

ABSOLUTE RULES:
1. Call the \`emit_plan\` tool ONCE with the complete plan. Do not output prose before or after the tool call.
2. The plan is a FLAT ORDERED LIST of milestones. The agent executes them in order.
3. Each milestone must be a coherent unit of work — typically 1-3 file operations or one verification step. Do NOT make one milestone per file (too granular) and do NOT make one milestone for the whole build (too coarse). Aim for 3-7 milestones for a typical small build.
4. Order milestones logically: foundation first (scaffolding, config, deps), then feature work, then verification last.
5. Every "must" requirement in the spec MUST be satisfied by at least one milestone. Every "doneCriteria" item MUST be checkable after the plan completes (either by a milestone doing it or by a final verification milestone).
6. "wont" items are explicit non-goals — no milestone should do these.
7. The "satisfies" field on each milestone should COPY the exact text of the spec requirement(s) it addresses, so coverage is mechanically verifiable.
8. Be honest about credit estimates. A Read milestone is ~50-100 credits. A Create is ~200-500. A Run (verification) is ~50-150.
9. "isMajor" should be true for milestones that create files, run commands, or edit config — anything where a human reviewer might want to pause. Pure reads are not major.

${specBlock}

ORIGINAL IDEA (for context):
  ${ideaText}

Output ONLY the \`emit_plan\` tool call. No preamble, no explanation.
${principlesBlock()}`;
}

// ----------------------------------------------------------------------
// PlanningService
// ----------------------------------------------------------------------

export class PlanningService {
    private readonly _provider: IConstructAIProvider;
    private readonly _maxTokens: number;
    private readonly _temperature: number;
    private readonly _log: (message: string) => void;

    constructor(config: PlanningServiceConfig) {
        this._provider = config.aiProvider;
        this._maxTokens = config.maxTokens ?? 4096;
        this._temperature = config.temperature ?? 0.2;
        this._log = config.log ?? (() => { /* no-op */ });
    }

    /**
     * Make ONE LLM call to generate the milestone plan from the approved spec.
     *
     * SERVER-SIDE ENFORCEMENT
     * -----------------------
     * If the LLM emits text instead of calling emit_plan, we retry up to
     * MAX_RETRIES times with a "you must call emit_plan" hint. If it calls
     * emit_plan with an empty milestones array, we retry with a "plan is
     * empty" hint. After MAX_RETRIES, we accept whatever we have (better to
     * return something than to hang).
     */
    async plan(input: {
        spec: RefinementSpec;
        ideaText: string;
        signal?: AbortSignal;
    }): Promise<PlanResult> {
        const { spec, ideaText, signal } = input;

        this._log(`[plan] spec: must=${spec.must.length} should=${spec.should.length} wont=${spec.wont.length} doneCriteria=${spec.doneCriteria.length}`);

        const tool = buildEmitPlanTool();
        const systemPrompt = buildSystemPrompt(spec, ideaText);

        const baseUserContent = `Generate the milestone plan for the approved spec above. Call \`emit_plan\` with the complete ordered list of milestones. Remember: every "must" and "doneCriteria" item must be covered by at least one milestone's "satisfies" field.`;

        const MAX_RETRIES = 2;
        let attempt = 0;
        let lastPlan: PlanResult | null = null;
        let lastError: 'no_tool_call' | 'empty_plan' | null = null;

        while (attempt <= MAX_RETRIES) {
            let userContent = baseUserContent;
            if (lastError === 'no_tool_call') {
                userContent += '\n\nCORRECTION: Your previous response did not call `emit_plan`. You MUST call the `emit_plan` tool now. Output ONLY the tool call — no text before or after.';
            } else if (lastError === 'empty_plan') {
                userContent += '\n\nCORRECTION: Your previous `emit_plan` call had an empty milestones array. Call `emit_plan` again with at least 3 milestones that cover the spec\'s "must" requirements.';
            }

            const userMessage: IChatMessage = {
                role: 'user',
                content: userContent,
            };

            let proseText = '';
            let emittedPlan: PlanResult | null = null;

            if (attempt > 0) {
                this._log(`[plan] retry attempt ${attempt} (hint=${lastError})`);
            }

            const stream = this._provider.chat(
                [userMessage],
                [tool],
                {
                    systemPrompt,
                    maxTokens: this._maxTokens,
                    temperature: this._temperature,
                    signal,
                },
            );

            for await (const event of stream as AsyncIterable<AIStreamEvent>) {
                switch (event.type) {
                    case 'token':
                        proseText += event.text;
                        break;
                    case 'tool_start':
                        if (event.toolName !== EMIT_PLAN_TOOL_NAME) {
                            this._log(`[plan] WARNING: unexpected tool_start: ${event.toolName}`);
                        }
                        break;
                    case 'tool_end': {
                        if (event.toolName === EMIT_PLAN_TOOL_NAME) {
                            const inp = event.toolInput as { summary?: string; milestones?: unknown } | null;
                            const normalized = normalizePlan(inp);
                            if (normalized) {
                                emittedPlan = normalized;
                                this._log(`[plan] emit_plan received: ${normalized.milestones.length} milestones`);
                            } else {
                                this._log(`[plan] emit_plan received but failed to normalize`);
                            }
                        }
                        break;
                    }
                    case 'done':
                        break;
                    case 'error':
                        throw new Error(`LLM stream error: ${event.text}`);
                }
            }

            if (emittedPlan) {
                if (emittedPlan.milestones.length === 0) {
                    lastError = 'empty_plan';
                    lastPlan = emittedPlan; // keep as fallback
                    attempt++;
                    continue;
                }
                // Success.
                return emittedPlan;
            }

            // No tool call — retry.
            lastError = 'no_tool_call';
            attempt++;
        }

        // Exhausted retries. Return the best we have.
        if (lastPlan) {
            this._log(`[plan] WARNING: exhausted retries. Returning last (possibly empty) plan.`);
            return lastPlan;
        }

        // Shouldn't reach here, but be defensive — return a minimal plan
        // derived from the spec's must requirements so the UI doesn't crash.
        this._log(`[plan] WARNING: no plan received from LLM. Synthesizing fallback from spec.`);
        return synthesizeFallbackPlan(spec);
    }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

function normalizePlan(input: { summary?: string; milestones?: unknown } | null | undefined): PlanResult | null {
    if (!input) { return null; }
    const summary = typeof input.summary === 'string' ? input.summary : '';
    if (!Array.isArray(input.milestones)) {
        return { summary, milestones: [] };
    }
    const milestones: PlanMilestone[] = [];
    for (let i = 0; i < input.milestones.length; i++) {
        const raw = input.milestones[i] as Record<string, unknown>;
        if (!raw || typeof raw !== 'object') { continue; }
        const name = typeof raw.name === 'string' ? raw.name : `Milestone ${i + 1}`;
        const description = typeof raw.description === 'string' ? raw.description : '';
        const satisfies = Array.isArray(raw.satisfies)
            ? raw.satisfies.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
            : [];
        const estimatedCredits = typeof raw.estimatedCredits === 'number' && isFinite(raw.estimatedCredits)
            ? Math.max(1, Math.round(raw.estimatedCredits))
            : 200;
        const typeRaw = typeof raw.type === 'string' ? raw.type : 'Create';
        const type: MilestoneType = (['Read', 'Create', 'Edit', 'Run'].includes(typeRaw) ? typeRaw : 'Create') as MilestoneType;
        const isMajorRaw = typeof raw.isMajor === 'boolean' ? raw.isMajor : null;
        // If LLM didn't set isMajor, derive it: Create/Run are major, Read is not, Edit is major.
        const isMajor = isMajorRaw !== null ? isMajorRaw : (type === 'Create' || type === 'Run' || type === 'Edit');
        milestones.push({
            id: 'm' + (i + 1),
            name,
            description,
            satisfies,
            estimatedCredits,
            type,
            isMajor,
        });
    }
    return { summary, milestones };
}

/**
 * Last-resort fallback: if the LLM completely fails to emit a plan, build a
 * trivial 1-milestone-per-must plan from the spec. This keeps the UI flow
 * moving so the user can see something happened.
 */
function synthesizeFallbackPlan(spec: RefinementSpec): PlanResult {
    const milestones: PlanMilestone[] = spec.must.map((req, i) => ({
        id: 'm' + (i + 1),
        name: `Implement: ${req.substring(0, 60)}${req.length > 60 ? '...' : ''}`,
        description: `Fallback milestone synthesized from spec must-requirement: "${req}". The LLM did not emit a real plan; this is a placeholder so the build flow can proceed. The agent will attempt to satisfy this requirement directly.`,
        satisfies: [req],
        estimatedCredits: 300,
        type: 'Create' as const,
        isMajor: true,
    }));
    if (spec.doneCriteria.length > 0) {
        milestones.push({
            id: 'm' + (milestones.length + 1),
            name: 'Verify against done criteria',
            description: `Run verification to confirm all done criteria pass: ${spec.doneCriteria.join('; ')}`,
            satisfies: spec.doneCriteria,
            estimatedCredits: 100,
            type: 'Run' as const,
            isMajor: true,
        });
    }
    return {
        summary: 'Fallback plan synthesized from spec (LLM did not emit a structured plan).',
        milestones,
    };
}
