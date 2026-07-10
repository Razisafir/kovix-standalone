/**
 * AgentLoop — Kovix 2.0 Phase 1 + 2 + 3.
 *
 * Phase 1: runTask() — plain tool-calling loop.
 * Phase 2: runMilestoneTask() — plan → execute each milestone.
 * Phase 3: EventEmitter + Approval Gate for destructive tools.
 *
 * Events emitted (all are strings; payloads documented below):
 *  - 'plan_ready'           — (plan: Milestone[]) after parsing the Lead Architect's plan.
 *  - 'milestone_started'    — (milestoneId: string) when a milestone enters EXECUTING.
 *  - 'milestone_verified'   — (milestoneId: string) when a milestone reaches VERIFIED.
 *  - 'milestone_failed'     — (milestoneId: string) when a milestone reaches FAILED.
 *  - 'llm_text'             — (text: string) when the LLM emits text content.
 *  - 'tool_call'            — ({ callId, name, args }) before executing a tool.
 *  - 'tool_result'          — ({ callId, result: { ok, output } }) after executing.
 *  - 'approval_required'    — ({ callId, name, args }) when a destructive tool needs
 *                             user approval. The loop PAUSES until approveToolCall()
 *                             or rejectToolCall() is called for that callId.
 *
 * Approval Gate:
 *  - Tools listed in DESTRUCTIVE_TOOLS require explicit approval before execution.
 *  - When such a tool is called, the loop emits 'approval_required' and awaits a
 *    Promise that is resolved externally by approveToolCall() / rejectToolCall().
 *  - approveToolCall(callId) → executes the tool, resolves with its result string.
 *  - rejectToolCall(callId)  → resolves with "Error: User rejected this tool call."
 *    WITHOUT executing the tool. The LLM sees this error and can adapt.
 *  - Non-destructive tools (read_file, list_files) execute immediately, no gate.
 */
import { EventEmitter } from 'node:events';
import type { LLMMessage, LLMProvider, LLMResponse } from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext, ToolExecutionResult } from '../tools/types.js';
import { MilestoneManager } from '../milestones/MilestoneManager.js';
import type { Milestone, PlannedMilestone } from '../milestones/types.js';

const SYSTEM_PROMPT =
  'You are Kovix, an autonomous AI engineer. You break down tasks and use tools to accomplish them. Do not just talk. Use tools to read and write files to complete the task.';

const PLANNING_SYSTEM_PROMPT =
  'You are a Lead Architect. Break down the user\'s task into 1-3 actionable milestones. Return ONLY a JSON array of objects with \'title\' and \'description\' fields.';

const DEFAULT_MAX_ITERATIONS = 15;

/**
 * Tools that require explicit user approval before execution.
 * Currently only `write_file` — add `delete_file`, `move_file`, etc. here
 * as they are implemented.
 */
const DESTRUCTIVE_TOOLS = new Set<string>(['write_file']);

/** Event names as constants — prevents typos in emit/on calls. */
export const AGENT_EVENTS = {
  plan_ready: 'plan_ready',
  milestone_started: 'milestone_started',
  milestone_verified: 'milestone_verified',
  milestone_failed: 'milestone_failed',
  llm_text: 'llm_text',
  tool_call: 'tool_call',
  tool_result: 'tool_result',
  approval_required: 'approval_required',
} as const;

export interface AgentLoopOptions {
  provider: LLMProvider;
  registry: ToolRegistry;
  workspaceRoot: string;
  /** System prompt override. Defaults to the Kovix autonomous-engineer prompt. */
  systemPrompt?: string;
  /** Max LLM round-trips before the loop gives up. Defaults to 15. */
  maxIterations?: number;
}

/**
 * Internal record for a pending approval. Stored in `pendingApprovals` until
 * the user calls approveToolCall() or rejectToolCall().
 */
interface PendingApproval {
  toolName: string;
  argsJson: string;
  ctx: ToolContext;
  /** Resolves with the tool result string (either the real result or the rejection message). */
  resolve: (result: string) => void;
}

export class AgentLoop extends EventEmitter {
  private readonly provider: LLMProvider;
  private readonly registry: ToolRegistry;
  private readonly workspaceRoot: string;
  private readonly systemPrompt: string;
  private readonly maxIterations: number;
  private readonly messageHistory: LLMMessage[] = [];
  private readonly milestones = new MilestoneManager();

  /**
   * Phase 3: pending approval gates. Keyed by tool call ID.
   * When non-empty, the tool loop is blocked waiting for user action.
   */
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(opts: AgentLoopOptions) {
    super();
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.workspaceRoot = opts.workspaceRoot;
    this.systemPrompt = opts.systemPrompt ?? SYSTEM_PROMPT;
    this.maxIterations = opts.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  }

  getHistory(): readonly LLMMessage[] {
    return this.messageHistory;
  }

  getMilestonePlan(): readonly Milestone[] {
    return this.milestones.getPlan();
  }

  /** Returns true if the tool requires approval before execution. */
  requiresApproval(toolName: string): boolean {
    return DESTRUCTIVE_TOOLS.has(toolName);
  }

  /**
   * Approve a pending tool call. Executes the tool and resolves the blocked
   * Promise with the tool's result. No-op if the callId is not pending
   * (e.g. already approved/rejected, or never required approval).
   */
  approveToolCall(callId: string): void {
    const pending = this.pendingApprovals.get(callId);
    if (!pending) {
      console.warn(`[approval] approveToolCall: unknown callId "${callId}"`);
      return;
    }
    this.pendingApprovals.delete(callId);
    // Execute the tool asynchronously and resolve the waiting Promise.
    void this.registry
      .executeTool(pending.toolName, pending.argsJson, pending.ctx)
      .then((result: ToolExecutionResult) => {
        pending.resolve(result.output);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        pending.resolve(`Error: tool threw during approved execution: ${msg}`);
      });
  }

  /**
   * Reject a pending tool call. Resolves the blocked Promise with
   * "Error: User rejected this tool call." WITHOUT executing the tool.
   * The LLM sees this error and can adapt its approach.
   */
  rejectToolCall(callId: string): void {
    const pending = this.pendingApprovals.get(callId);
    if (!pending) {
      console.warn(`[approval] rejectToolCall: unknown callId "${callId}"`);
      return;
    }
    this.pendingApprovals.delete(callId);
    pending.resolve('Error: User rejected this tool call.');
  }

  /**
   * Phase 1 entry point. Seeds history and runs the tool loop once.
   */
  async runTask(userPrompt: string): Promise<void> {
    this.messageHistory.push({ role: 'system', content: this.systemPrompt });
    this.messageHistory.push({ role: 'user', content: userPrompt });
    await this.runToolLoop();
  }

  /**
   * Phase 2 + 3 entry point. Plans milestones, then executes each with
   * the approval-gated tool loop.
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

    // Emit plan_ready with the full plan (statuses all PLANNED at this point).
    this.emit(AGENT_EVENTS.plan_ready, this.milestones.getPlan());

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
      this.emit(AGENT_EVENTS.milestone_started, current.id);

      try {
        this.messageHistory.push({
          role: 'system',
          content: `You are now executing Milestone: ${current.title}. Objective: ${current.description}. Complete it using tools.`,
        });

        await this.runToolLoop();

        this.milestones.updateStatus(current.id, 'VERIFIED');
        this.emit(AGENT_EVENTS.milestone_verified, current.id);
        console.log(`[milestone] ${current.id} "${current.title}" → VERIFIED`);
      } catch (err) {
        this.milestones.updateStatus(current.id, 'FAILED');
        this.emit(AGENT_EVENTS.milestone_failed, current.id);
        console.log(`[milestone] ${current.id} "${current.title}" → FAILED`);
        throw err;
      }

      current = this.milestones.getNextExecutable();
    }

    return this.milestones.getPlan();
  }

  /**
   * Inner tool-calling loop with approval gate. Shared by runTask and runMilestoneTask.
   *
   * For each tool call in an assistant response:
   *  1. Emit 'tool_call' event.
   *  2. If the tool is destructive (in DESTRUCTIVE_TOOLS):
   *     a. Emit 'approval_required'.
   *     b. Await the approval Promise (resolved by approveToolCall/rejectToolCall).
   *     c. On reject, the result is "Error: User rejected this tool call."
   *  3. If non-destructive, execute immediately via the registry.
   *  4. Emit 'tool_result' event.
   *  5. Append the tool result to message history.
   */
  private async runToolLoop(): Promise<void> {
    const toolCtx: ToolContext = { workspaceRoot: this.workspaceRoot };

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      console.log(`\n--- Iteration ${iteration}/${this.maxIterations} ---`);

      const response: LLMResponse = await this.provider.chat(
        this.messageHistory,
        this.registry.getAllToolSchemas(),
      );

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
        this.emit(AGENT_EVENTS.llm_text, response.content);
      }

      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const call of response.tool_calls) {
          console.log(
            `[tool_call] ${call.function.name}(${call.function.arguments})`,
          );

          // Parse args once for the event payload. If JSON.parse fails, pass
          // the raw string so the UI can at least display something.
          let parsedArgs: unknown;
          try {
            parsedArgs = JSON.parse(call.function.arguments);
          } catch {
            parsedArgs = call.function.arguments;
          }

          this.emit(AGENT_EVENTS.tool_call, {
            callId: call.id,
            name: call.function.name,
            args: parsedArgs,
          });

          // Execute — with approval gate for destructive tools.
          let resultOutput: string;
          let resultOk: boolean;

          if (this.requiresApproval(call.function.name)) {
            resultOutput = await this.requestApproval(
              call.id,
              call.function.name,
              call.function.arguments,
              parsedArgs,
              toolCtx,
            );
            // Rejection produces "Error: ..." — treat as not-ok for the event.
            resultOk = !resultOutput.startsWith('Error:');
          } else {
            const result = await this.registry.executeTool(
              call.function.name,
              call.function.arguments,
              toolCtx,
            );
            resultOutput = result.output;
            resultOk = result.ok;
          }

          const preview =
            resultOutput.length > 200
              ? resultOutput.slice(0, 200) + '…(truncated in log)'
              : resultOutput;
          console.log(`[tool_result] ${resultOk ? 'ok' : 'ERR'}: ${preview}`);

          this.emit(AGENT_EVENTS.tool_result, {
            callId: call.id,
            result: { ok: resultOk, output: resultOutput },
          });

          this.messageHistory.push({
            role: 'tool',
            content: resultOutput,
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

  /**
   * Phase 3: Request user approval for a destructive tool call.
   *
   * Emits 'approval_required' and returns a Promise that resolves when
   * approveToolCall() or rejectToolCall() is called for this callId.
   * The resolved value is the tool's result string (on approve) or
   * "Error: User rejected this tool call." (on reject).
   */
  private requestApproval(
    callId: string,
    toolName: string,
    argsJson: string,
    parsedArgs: unknown,
    ctx: ToolContext,
  ): Promise<string> {
    return new Promise<string>((resolve) => {
      // Store the resolver so approveToolCall/rejectToolCall can trigger it.
      this.pendingApprovals.set(callId, {
        toolName,
        argsJson,
        ctx,
        resolve,
      });

      console.log(`[approval_required] ${toolName} (callId=${callId})`);
      this.emit(AGENT_EVENTS.approval_required, {
        callId,
        name: toolName,
        args: parsedArgs,
      });
    });
  }
}

/**
 * Parse the Lead Architect's JSON plan into `PlannedMilestone[]`.
 * (Unchanged from Phase 2 — documented here for completeness.)
 */
function parsePlannedMilestones(raw: string): PlannedMilestone[] {
  let text = raw.trim();

  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Fall through to bracket extraction.
  }

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
