/**
 * AgentLoop — the autonomous agent's main loop. Kovix 2.0 Phase 1 + Phase 2.
 *
 * Two entry points:
 *  - `runTask(prompt)`            [Phase 1] Plain tool-calling loop. Used when
 *                                  the caller has already decomposed the work
 *                                  and just wants the agent to execute one
 *                                  instruction.
 *  - `runMilestoneTask(prompt)`   [Phase 2] Two-phase: first asks the LLM to
 *                                  emit a JSON plan of milestones, then
 *                                  executes each milestone via the same
 *                                  tool-calling loop. Returns the final
 *                                  milestone plan with statuses.
 *
 * Phase 2 lifecycle per milestone:
 *   PLANNED → EXECUTING → (run tool loop) → VERIFIED
 *                            ↓ (on throw)
 *                          FAILED, exception re-thrown to caller
 *
 * Design notes:
 *  - `messageHistory` persists across milestones within a single
 *    `runMilestoneTask` call. The agent sees prior milestones' results,
 *    which is the whole point of sequential execution.
 *  - The tool-calling inner loop is extracted to `runToolLoop()` so both
 *    `runTask` and `runMilestoneTask` share it.
 *  - JSON parsing of the planning response is defensive: strips markdown
 *    code fences and tries to locate a JSON array inside the text. Failure
 *    to parse throws — the caller decides whether to retry or surface.
 *  - `console.log` is used for visibility; the verify script greps these.
 */
import type { LLMMessage, LLMProvider, LLMResponse } from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';
import { MilestoneManager } from '../milestones/MilestoneManager.js';
import type { Milestone, PlannedMilestone } from '../milestones/types.js';

const SYSTEM_PROMPT =
  'You are Kovix, an autonomous AI engineer. You break down tasks and use tools to accomplish them. Do not just talk. Use tools to read and write files to complete the task.';

const PLANNING_SYSTEM_PROMPT =
  'You are a Lead Architect. Break down the user\'s task into 1-3 actionable milestones. Return ONLY a JSON array of objects with \'title\' and \'description\' fields.';

const DEFAULT_MAX_ITERATIONS = 15;

export interface AgentLoopOptions {
  provider: LLMProvider;
  registry: ToolRegistry;
  workspaceRoot: string;
  /** System prompt override. Defaults to the Kovix autonomous-engineer prompt. */
  systemPrompt?: string;
  /** Max LLM round-trips before the loop gives up. Defaults to 15. */
  maxIterations?: number;
}

export class AgentLoop {
  private readonly provider: LLMProvider;
  private readonly registry: ToolRegistry;
  private readonly workspaceRoot: string;
  private readonly systemPrompt: string;
  private readonly maxIterations: number;
  private readonly messageHistory: LLMMessage[] = [];
  /** Phase 2: one manager per AgentLoop instance. Reset on each runMilestoneTask. */
  private readonly milestones = new MilestoneManager();

  constructor(opts: AgentLoopOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.workspaceRoot = opts.workspaceRoot;
    this.systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }

  /** Read-only view of the conversation history (for tests / debugging). */
  getHistory(): readonly LLMMessage[] {
    return this.messageHistory;
  }

  /** Read-only view of the milestone plan (Phase 2). */
  getMilestonePlan(): readonly Milestone[] {
    return this.milestones.getPlan();
  }

  /**
   * Run the agent loop against a user prompt. Returns when the LLM emits a
   * `stop` without tool calls, or throws when max iterations is exceeded.
   *
   * This is the Phase 1 entry point — kept working so existing callers
   * don't break.
   */
  async runTask(userPrompt: string): Promise<void> {
    this.messageHistory.push({ role: 'system', content: this.systemPrompt });
    this.messageHistory.push({ role: 'user', content: userPrompt });
    await this.runToolLoop();
  }

  /**
   * Run the agent with milestone planning. Kovix 2.0 Phase 2.
   *
   * Phase A (Planning): one LLM call without tools, asking for a JSON plan.
   * Phase B (Plan load): parse the JSON, load milestones into the manager.
   * Phase C (Execution): for each PLANNED milestone, mark EXECUTING, inject
   *   a system message describing the milestone, run the tool loop, mark
   *   VERIFIED. If the loop throws, mark FAILED and re-throw.
   *
   * Returns the final milestone plan with terminal statuses.
   */
  async runMilestoneTask(userPrompt: string): Promise<Milestone[]> {
    // ── Phase A: Planning ────────────────────────────────────────────────
    console.log('\n========== PHASE A: PLANNING ==========');
    const planMessages: LLMMessage[] = [
      { role: 'system', content: PLANNING_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ];
    const planResponse = await this.provider.chat(planMessages);
    if (!planResponse.content) {
      throw new Error('Planning LLM returned no content');
    }
    console.log(`[plan] raw LLM output:\n${planResponse.content}`);

    // ── Phase B: Parse plan & load into manager ──────────────────────────
    const planned = parsePlannedMilestones(planResponse.content);
    if (planned.length === 0) {
      throw new Error('Planning LLM returned zero milestones');
    }
    this.milestones.setPlan(planned);
    console.log(
      `[plan] loaded ${planned.length} milestone(s): ${planned
        .map((p) => `"${p.title}"`)
        .join(', ')}`,
    );

    // Seed the execution-time history with the agent system prompt + the
    // user's original prompt. Each milestone will append a system message
    // describing its objective before running the tool loop.
    this.messageHistory.push({ role: 'system', content: this.systemPrompt });
    this.messageHistory.push({ role: 'user', content: userPrompt });

    // ── Phase C: Execute milestones sequentially ─────────────────────────
    console.log('\n========== PHASE C: EXECUTION ==========');
    let current = this.milestones.getNextExecutable();
    while (current) {
      console.log(
        `\n>>>>> MILESTONE ${current.id}: ${current.title} <<<<<\n     ${current.description}`,
      );
      this.milestones.updateStatus(current.id, 'EXECUTING');

      try {
        // Inject the milestone objective as a system message. This gives
        // the LLM clear focus for the upcoming tool-calling loop without
        // erasing the prior conversation history.
        this.messageHistory.push({
          role: 'system',
          content: `You are now executing Milestone: ${current.title}. Objective: ${current.description}. Complete it using tools.`,
        });

        await this.runToolLoop();

        this.milestones.updateStatus(current.id, 'VERIFIED');
        console.log(`[milestone] ${current.id} "${current.title}" → VERIFIED`);
      } catch (err) {
        this.milestones.updateStatus(current.id, 'FAILED');
        console.log(`[milestone] ${current.id} "${current.title}" → FAILED`);
        // Re-throw so the caller knows the run failed. The plan (with the
        // FAILED status) is still queryable via getMilestonePlan().
        throw err;
      }

      current = this.milestones.getNextExecutable();
    }

    return this.milestones.getPlan();
  }

  /**
   * Inner tool-calling loop. Shared by `runTask` and `runMilestoneTask`.
   *
   * Loops until the LLM emits a `stop` without tool calls, or until
   * `maxIterations` is exceeded. Mutates `messageHistory` in place.
   */
  private async runToolLoop(): Promise<void> {
    const toolCtx: ToolContext = { workspaceRoot: this.workspaceRoot };

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      console.log(`\n--- Iteration ${iteration}/${this.maxIterations} ---`);

      const response: LLMResponse = await this.provider.chat(
        this.messageHistory,
        this.registry.getAllToolSchemas(),
      );

      // Append the assistant message (with tool_calls if present) so the
      // next call sees the prior request.
      const assistantMsg: LLMMessage = {
        role: 'assistant',
        content: response.content,
      };
      if (response.tool_calls && response.tool_calls.length > 0) {
        assistantMsg.tool_calls = response.tool_calls;
      }
      this.messageHistory.push(assistantMsg);

      if (response.content) {
        console.log(`[llm] ${response.content}`);
      }

      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const call of response.tool_calls) {
          console.log(
            `[tool_call] ${call.function.name}(${call.function.arguments})`,
          );
          const result = await this.registry.executeTool(
            call.function.name,
            call.function.arguments,
            toolCtx,
          );
          const preview =
            result.output.length > 200
              ? result.output.slice(0, 200) + '…(truncated in log)'
              : result.output;
          console.log(`[tool_result] ${result.ok ? 'ok' : 'ERR'}: ${preview}`);

          this.messageHistory.push({
            role: 'tool',
            content: result.output,
            tool_call_id: call.id,
            name: call.function.name,
          });
        }
        continue;
      }

      if (response.stop_reason === 'stop') {
        console.log('[done] milestone/task complete');
        return;
      }

      console.log(`[note] non-stop stop_reason: ${response.stop_reason}`);
    }

    throw new Error(
      `AgentLoop exceeded max iterations (${this.maxIterations}) without completing the task`,
    );
  }
}

/**
 * Parse the Lead Architect's JSON plan into `PlannedMilestone[]`.
 *
 * Robustness measures:
 *  - Strip markdown code fences (```json ... ``` or ``` ... ```).
 *  - Tolerate leading/trailing prose by extracting the first `[...]` block.
 *  - Validate that each element has string `title` and `description`.
 *  - Drop invalid elements rather than failing the whole parse — partial
 *    plans are still actionable.
 *
 * @throws if no valid JSON array can be extracted.
 */
function parsePlannedMilestones(raw: string): PlannedMilestone[] {
  let text = raw.trim();

  // Strip markdown code fences. Match ```json ... ``` or ``` ... ```.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Try direct parse first.
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fall through to bracket extraction.
  }

  // If direct parse failed, extract the first [...] block and retry.
  if (parsed === null) {
    const bracketMatch = text.match(/\[[\s\S]*\]/);
    if (!bracketMatch) {
      throw new Error(
        `Could not extract JSON array from planning output: ${raw.slice(0, 200)}…`,
      );
    }
    try {
      parsed = JSON.parse(bracketMatch[0]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Planning output is not valid JSON: ${msg}`);
    }
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      `Planning output is not a JSON array (got ${typeof parsed})`,
    );
  }

  // Validate each element. Drop invalid ones with a warning.
  const result: PlannedMilestone[] = [];
  for (let i = 0; i < parsed.length; i++) {
    const el = parsed[i];
    if (
      typeof el === 'object' &&
      el !== null &&
      typeof (el as Record<string, unknown>).title === 'string' &&
      typeof (el as Record<string, unknown>).description === 'string'
    ) {
      const e = el as { title: string; description: string };
      result.push({ title: e.title, description: e.description });
    } else {
      console.warn(
        `[plan] dropped invalid milestone at index ${i}: ${JSON.stringify(el)}`,
      );
    }
  }

  return result;
}
