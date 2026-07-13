/**
 * RefinementService — Build mode Phase 1: idea → spec via one-question-at-a-time
 * refinement dialogue.
 *
 * CONTRACT
 * --------
 * Input  : { ideaText, priorTurns }
 * Output : { kind: 'question', text } | { kind: 'spec', spec }
 *
 * The UI loops this call: get a question → show it → user answers → call again
 * with the new turn appended → eventually the LLM calls `emit_spec` and we
 * return the structured spec.
 *
 * STRUCTURED OUTPUT
 * -----------------
 * The "next question" vs "final spec" distinction is made PROGRAMMATICALLY by
 * whether the LLM called the `emit_spec` tool, NOT by parsing the prose. If the
 * LLM emits text only → question. If the LLM emits an `emit_spec` tool call →
 * spec. This is the contract the user asked for in the Phase 1 spec.
 *
 * PROVIDER REUSE
 * --------------
 * This service does NOT make HTTP calls directly. It calls `provider.chat()`
 * — the same IConstructAIProvider interface the agent loop uses. So any
 * provider created via `createProvider()` (Anthropic, OpenRouter, Ollama, etc.)
 * works here with zero additional wiring.
 *
 * The event-stream contract (AIStreamEvent) is the same one the agent loop
 * consumes. We just collect tokens into a string and watch for tool_end on
 * `emit_spec`.
 */

import type {
    IConstructAIProvider,
    IChatMessage,
    IToolDefinition,
    AIStreamEvent,
} from '../llm/types.js';
import { principlesBlock } from '../agentPrinciples.js';

// ----------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------

/** One round of the refinement conversation. */
export interface RefinementTurn {
    role: 'user' | 'assistant';
    content: string;
}

/** The final structured spec — the formal contract for the build phase. */
export interface RefinementSpec {
    /** Hard requirements. The build is incomplete without these. */
    must: string[];
    /** Nice-to-haves. Would improve quality but not blocking. */
    should: string[];
    /** Explicit non-goals. Out of scope for this build. */
    wont: string[];
    /** Verifiable checks. When all pass, the build is done. */
    doneCriteria: string[];
}

/** What refine() returns — either the next question or the final spec. */
export type RefinementResult =
    | { kind: 'question'; text: string }
    | { kind: 'spec'; spec: RefinementSpec };

export interface RefinementServiceConfig {
    /** The LLM provider — must come from createProvider(). */
    aiProvider: IConstructAIProvider;
    /**
     * Hard cap on the number of question/answer rounds before we FORCE the
     * LLM to emit a spec. Default 5. If priorTurns has ≥ 2*maxTurns entries,
     * we add a "you must call emit_spec now" instruction to the system prompt.
     */
    maxTurns?: number;
    /**
     * Minimum number of question/answer rounds before the LLM is allowed to
     * finalize. Default 3. The system prompt forbids emit_spec before this.
     */
    minTurns?: number;
    /** Max tokens for the LLM response. Default 2048 — questions are short but specs can be long. */
    maxTokens?: number;
    /**
     * Temperature for sampling. Default 0.2 — very low for deterministic,
     * focused questions. Higher temperatures make smaller free models
     * "think out loud" with multi-paragraph internal monologue instead of
     * asking one clean question.
     */
    temperature?: number;
    /** Logger. Default: no-op. */
    log?: (message: string) => void;
}

// ----------------------------------------------------------------------
// The emit_spec tool definition
// ----------------------------------------------------------------------

const EMIT_SPEC_TOOL_NAME = 'emit_spec';

function buildEmitSpecTool(): IToolDefinition {
    return {
        name: EMIT_SPEC_TOOL_NAME,
        description:
            'Emit the final structured spec for the build. Call this ONLY after you have asked enough clarifying questions (at least the minimum specified in the system prompt). Once you call this, refinement is complete and the spec arrays become the formal contract for the build phase. Do NOT call this prematurely — if there is any meaningful ambiguity left, ask another question instead.',
        inputSchema: {
            type: 'object',
            properties: {
                must: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Hard requirements. The build is incomplete without these. Each entry should be a single, verifiable statement (e.g. "User can create an account with email + password"). Aim for 3-7 items.',
                },
                should: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Nice-to-haves. Would improve quality but are not blocking. Each entry should be a single, verifiable statement. Aim for 0-5 items.',
                },
                wont: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Explicit non-goals. Out of scope for this build. Calling these out prevents scope creep. Each entry should be a single statement (e.g. "No social login — email/password only"). Aim for 1-5 items.',
                },
                doneCriteria: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Verifiable done-checks. When ALL of these pass, the build is done. Each must be checkable by running a command or inspecting an artifact — NOT subjective (so "looks good" is forbidden; "all 5 endpoints return 200 with valid JSON" is fine). Aim for 3-7 items.',
                },
            },
            required: ['must', 'should', 'wont', 'doneCriteria'],
        },
    };
}

// ----------------------------------------------------------------------
// System prompt
// ----------------------------------------------------------------------

type SystemPromptHint =
    | { kind: 'too_early'; lastSpec: RefinementSpec | null }
    | { kind: 'empty_spec'; lastSpec: RefinementSpec }
    | { kind: 'force_finalize_retry' };

function buildSystemPrompt(
    minTurns: number,
    maxTurns: number,
    currentTurn: number,
    forceFinalize: boolean,
    hint?: SystemPromptHint,
): string {
    const base = `You are the Build mode refinement assistant for Kovix, an agent-first desktop app.

Your ONE job: refine a raw product idea into a clear, structured spec through one-question-at-a-time dialogue with the user.

ABSOLUTE RULES:
1. Ask EXACTLY ONE question per turn. NEVER ask a list of questions. NEVER combine multiple questions into one sentence. If you catch yourself writing "and also" or "additionally", stop — that's two questions.
2. Each question should clarify ONE of: scope, constraints, success criteria, non-goals, target user, or edge cases. Pick the most important unknown.
3. Make questions specific and answerable in 1-3 sentences by the user. Avoid open-ended philosophical questions.
4. Do NOT echo the user's answer back. Do NOT summarize. Do NOT preface the question with "Got it" or "Thanks". Just ask the next question directly.
5. After ${minTurns}-${maxTurns} question/answer rounds, STOP asking questions and call the \`emit_spec\` tool with the final structured spec.
6. The spec must have 4 arrays: must (hard requirements), should (nice-to-haves), wont (non-goals), doneCriteria (verifiable checks).
7. NEVER call \`emit_spec\` before you have asked at least ${minTurns} questions. Premature finalization is the worst failure mode.
8. Each entry in the spec arrays must be a single, specific, verifiable statement — not a paragraph.
9. NEVER emit empty arrays. Every array must have at least one entry. If you can't think of an entry for an array, you haven't asked enough questions — ask another question instead.

EXAMPLE OF A GOOD emit_spec CALL:
{
  "must": [
    "CLI accepts a folder path as the first argument",
    "Prints each changed file path to stdout, one per line",
    "Exits with non-zero status on fatal errors"
  ],
  "should": [
    "Print a summary line to stderr every 60 seconds with the count of changes detected"
  ],
  "wont": [
    "No GUI",
    "No remote sync",
    "No config file in v1"
  ],
  "doneCriteria": [
    "Running \`kovix-watch .\` prints a line within 1 second of saving any non-ignored file",
    "Exiting the process with Ctrl+C produces no error output",
    "Files in .git/ and node_modules/ never appear in stdout"
  ]
}

CURRENT STATE:
- Question/answer rounds so far: ${currentTurn}
- Minimum before finalize: ${minTurns}
- Hard cap: ${maxTurns}
${principlesBlock()}`;

    if (forceFinalize) {
        return base + `

FORCE FINALIZE: You have reached the hard cap of ${maxTurns} rounds. Your ONLY valid output is a tool call to \`emit_spec\`. Any text response will be rejected and you will be asked again. Do not think out loud. Do not summarize. Do not ask another question. Do not explain your reasoning. JUST call \`emit_spec\` with all 4 arrays populated based on what you've learned in the conversation so far. If you are unsure about a detail, make a reasonable default choice rather than asking.`;
    }

    if (hint?.kind === 'too_early') {
        const specSummary = hint.lastSpec
            ? `The spec you tried to emit had: must=${hint.lastSpec.must.length}, should=${hint.lastSpec.should.length}, wont=${hint.lastSpec.wont.length}, doneCriteria=${hint.lastSpec.doneCriteria.length}.`
            : 'The spec you tried to emit was empty.';
        return base + `

CORRECTION: You just called \`emit_spec\` after only ${currentTurn} rounds, but the minimum is ${minTurns}. ${specSummary} You jumped to finalize too early — there is still meaningful ambiguity to resolve. DO NOT call \`emit_spec\` this turn. Instead, ask ONE specific clarifying question about the most important remaining unknown (scope, constraints, success criteria, non-goals, target user, or edge cases). Output a single question as plain text — do NOT use the tool.`;
    }

    if (hint?.kind === 'empty_spec') {
        const s = hint.lastSpec;
        return base + `

CORRECTION: You just called \`emit_spec\` but the spec was incomplete:
- must had ${s.must.length} entries (need ≥1)
- should had ${s.should.length} entries (≥0 ok)
- wont had ${s.wont.length} entries (need ≥1)
- doneCriteria had ${s.doneCriteria.length} entries (need ≥1)

DO NOT call \`emit_spec\` again with empty arrays. Re-read the user's idea and the conversation so far, then call \`emit_spec\` with all 4 arrays populated with specific, verifiable statements derived from what you've learned. Use the EXAMPLE above as a guide for the level of specificity. If you genuinely cannot fill an array from the conversation, make a reasonable default choice based on the user's idea.`;
    }

    if (hint?.kind === 'force_finalize_retry') {
        return base + `

CRITICAL: You are past the hard cap of ${maxTurns} rounds and you just emitted TEXT instead of calling \`emit_spec\`. This is forbidden. Your previous text response was rejected. You MUST call \`emit_spec\` NOW. Do not output any text. Do not think out loud. Do not explain. Do not ask a question. The ONLY acceptable response is a single tool call to \`emit_spec\` with all 4 arrays populated. Use the conversation so far to construct the spec — make reasonable defaults for any ambiguity.`;
    }

    return base;
}

// ----------------------------------------------------------------------
// RefinementService
// ----------------------------------------------------------------------

export class RefinementService {
    private readonly _provider: IConstructAIProvider;
    private readonly _maxTurns: number;
    private readonly _minTurns: number;
    private readonly _maxTokens: number;
    private readonly _temperature: number;
    private readonly _log: (message: string) => void;

    constructor(config: RefinementServiceConfig) {
        this._provider = config.aiProvider;
        this._maxTurns = config.maxTurns ?? 5;
        this._minTurns = config.minTurns ?? 3;
        this._maxTokens = config.maxTokens ?? 2048;
        this._temperature = config.temperature ?? 0.2;
        this._log = config.log ?? (() => { /* no-op */ });
    }

    /**
     * Make ONE LLM call to advance the refinement conversation.
     *
     * @param input.ideaText    The original idea text (always included as the first user message).
     * @param input.priorTurns  The conversation so far — alternating assistant question / user answer.
     * @param input.signal      Optional AbortSignal.
     * @returns Either the next question or the final spec.
     *
     * SERVER-SIDE ENFORCEMENT
     * -----------------------
     * The system prompt ASKS the LLM not to call emit_spec before minTurns, but
     * smaller/flakier models ignore this. So the service ENFORCES it:
     *   - If the LLM calls emit_spec before minTurns, we DISCARD the spec and
     *     retry the call with a stern "you called emit_spec too early — ask a
     *     question instead" instruction appended.
     *   - If the LLM keeps trying to finalize prematurely, we keep retrying up
     *     to PREMATURE_FINALIZE_RETRY_LIMIT times, then accept whatever it
     *     gives us (better to return SOMETHING than to hang).
     *   - If completedRounds >= maxTurns, we set forceFinalize which tells the
     *     LLM "you MUST call emit_spec now" — and we accept the spec regardless
     *     of completeness.
     */
    async refine(input: {
        ideaText: string;
        priorTurns: RefinementTurn[];
        signal?: AbortSignal;
    }): Promise<RefinementResult> {
        const { ideaText, priorTurns, signal } = input;

        const completedRounds = Math.floor(priorTurns.length / 2);
        const forceFinalize = completedRounds >= this._maxTurns;

        this._log(`[refine] rounds=${completedRounds} min=${this._minTurns} max=${this._maxTurns} force=${forceFinalize}`);

        // Build the base message array. The idea is always the first user message.
        const baseMessages: IChatMessage[] = [
            { role: 'user', content: ideaText },
        ];
        for (const turn of priorTurns) {
            baseMessages.push({
                role: turn.role,
                content: turn.content,
            });
        }

        const tool = buildEmitSpecTool();

        // Retry loop: handles premature emit_spec calls and empty-spec calls.
        // We deliberately do NOT retry when forceFinalize=true and the LLM emits
        // text instead of a tool call — that just makes small models "think out
        // loud" more, hit rate limits, and never converge. Instead, the text
        // becomes the next "question" returned to the UI, the user (or test
        // script) gives another answer, and we try again next round. The
        // service's hard cap (caller's loop limit) is the safety net.
        let attempt = 0;
        const MAX_PREMATURE_RETRIES = 2;
        const MAX_EMPTY_SPEC_RETRIES = 2;
        let lastPrematureSpec: RefinementSpec | null = null;
        let lastEmptySpec: RefinementSpec | null = null;
        let emptySpecRetries = 0;
        // Total attempts across both retry kinds — prevents infinite loop.
        const MAX_TOTAL_ATTEMPTS = MAX_PREMATURE_RETRIES + MAX_EMPTY_SPEC_RETRIES + 1;

        while (attempt < MAX_TOTAL_ATTEMPTS) {
            // Pick the right hint: empty_spec takes priority (more recent failure)
            let hint: SystemPromptHint | undefined;
            if (lastEmptySpec) {
                hint = { kind: 'empty_spec', lastSpec: lastEmptySpec };
            } else if (lastPrematureSpec) {
                hint = { kind: 'too_early', lastSpec: lastPrematureSpec };
            }
            const isRetry = attempt > 0;

            const systemPrompt = buildSystemPrompt(
                this._minTurns,
                this._maxTurns,
                completedRounds,
                forceFinalize,
                hint,
            );

            if (isRetry) {
                this._log(`[refine] retry attempt ${attempt} (hint=${hint?.kind ?? 'none'})`);
            }

            let questionText = '';
            let emittedSpec: RefinementSpec | null = null;

            const stream = this._provider.chat(
                baseMessages,
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
                        questionText += event.text;
                        break;
                    case 'tool_start':
                        if (event.toolName !== EMIT_SPEC_TOOL_NAME) {
                            this._log(`[refine] WARNING: unexpected tool_start: ${event.toolName}`);
                        }
                        break;
                    case 'tool_end': {
                        if (event.toolName === EMIT_SPEC_TOOL_NAME) {
                            const input = event.toolInput as Partial<RefinementSpec> | null;
                            const spec = normalizeSpec(input);
                            emittedSpec = spec;
                            this._log(`[refine] emit_spec received: must=${spec.must.length} should=${spec.should.length} wont=${spec.wont.length} doneCriteria=${spec.doneCriteria.length}`);
                        }
                        break;
                    }
                    case 'done':
                        // Stream complete. If we got a spec, we'll handle below.
                        // If not, we'll return the collected text as a question.
                        break;
                    case 'error':
                        // MVP FIX: previously this threw, which escaped the retry
                        // loop and became an unhandled IPC rejection. The user
                        // would see a generic error dialog instead of a useful
                        // message in the chat. Now we return a question with the
                        // actual error text so the user knows what went wrong
                        // (rate limit, auth, network, etc.) and can act on it.
                        //
                        // Common error texts from cloudProvider.ts:
                        //   - "Rate limited." (429 after retries)
                        //   - "Server error (500)."  (5xx after retries)
                        //   - "API key is invalid." (401)
                        //   - "Network error: ..." (fetch failed)
                        this._log(`[refine] LLM stream error: ${event.text}`);
                        return {
                            kind: 'question',
                            text: `[OpenRouter Error]: ${event.text || 'Rate limited or empty response.'} Please try again or select a different model.`,
                        };
                }
            }

            // Case 1: LLM emitted a spec.
            if (emittedSpec) {
                // Premature check (before minTurns, not forcing finalize)
                if (!forceFinalize && completedRounds < this._minTurns) {
                    this._log(`[refine] LLM called emit_spec after only ${completedRounds} rounds (min ${this._minTurns}). Retrying as question.`);
                    lastPrematureSpec = emittedSpec;
                    lastEmptySpec = null; // reset empty-spec state since this is a different failure
                    attempt++;
                    continue;
                }
                // Empty-spec check: must and doneCriteria both required to be non-empty
                const isEmptySpec = emittedSpec.must.length === 0 || emittedSpec.doneCriteria.length === 0;
                if (isEmptySpec && !forceFinalize && emptySpecRetries < MAX_EMPTY_SPEC_RETRIES) {
                    emptySpecRetries++;
                    this._log(`[refine] LLM emitted spec with empty must or doneCriteria. Retrying to get filled spec (attempt ${emptySpecRetries}/${MAX_EMPTY_SPEC_RETRIES}).`);
                    lastEmptySpec = emittedSpec;
                    lastPrematureSpec = null; // reset premature state
                    attempt++;
                    continue;
                }
                // Accept the spec.
                return { kind: 'spec', spec: emittedSpec };
            }

            // Reset the per-iteration retry flag — will be re-set below if needed.
            // (force_finalize_retry is intentionally NOT used — see comment above.)

            // Case 2: LLM emitted text (no tool call).
            const trimmed = questionText.trim();

            // Not forcing finalize, or we've exhausted force-finalize retries.
            // Return the text as a question (or sentinel if empty).
            if (!trimmed) {
                this._log(`[refine] WARNING: LLM returned empty response with no tool call. Rounds=${completedRounds}`);
                return {
                    kind: 'question',
                    text: '[OpenRouter Error]: Rate limited or empty response. Please try again or select a different model.',
                };
            }
            return { kind: 'question', text: trimmed };
        }

        // We exhausted retries. Return the best spec we have (prefer non-empty).
        if (lastEmptySpec && (lastEmptySpec.must.length > 0 || lastEmptySpec.doneCriteria.length > 0)) {
            this._log(`[refine] WARNING: exhausted retries. Returning last (partially-filled) spec.`);
            return { kind: 'spec', spec: lastEmptySpec };
        }
        if (lastPrematureSpec && (lastPrematureSpec.must.length > 0 || lastPrematureSpec.doneCriteria.length > 0)) {
            this._log(`[refine] WARNING: exhausted retries. Returning last premature spec.`);
            return { kind: 'spec', spec: lastPrematureSpec };
        }

        // Shouldn't reach here, but be defensive.
        return {
            kind: 'question',
            text: '[OpenRouter Error]: Rate limited or empty response. Please try again or select a different model.',
        };
    }
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------

/**
 * Normalize whatever the LLM passed to emit_spec into a valid RefinementSpec.
 * Defensively coerces missing arrays to [], non-arrays to [], and non-strings
 * to strings. We trust the LLM's content but not its shape.
 */
function normalizeSpec(input: Partial<RefinementSpec> | null | undefined): RefinementSpec {
    const ensureStringArray = (val: unknown): string[] => {
        if (!Array.isArray(val)) { return []; }
        return val
            .map((item) => typeof item === 'string' ? item : String(item))
            .filter((s) => s.trim().length > 0);
    };
    return {
        must: ensureStringArray(input?.must),
        should: ensureStringArray(input?.should),
        wont: ensureStringArray(input?.wont),
        doneCriteria: ensureStringArray(input?.doneCriteria),
    };
}
