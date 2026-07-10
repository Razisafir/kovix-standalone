/**
 * AgentLoop — the autonomous agent's main loop. Kovix 2.0 Phase 1.
 *
 * The loop is intentionally simple and bulletproof:
 *
 *   1. Inject system prompt ("you are Kovix, use tools...").
 *   2. Append the user's prompt to history.
 *   3. Loop:
 *      a. Call LLM with full history + tool schemas.
 *      b. Append the LLM's assistant message to history.
 *      c. If there are tool_calls, execute each via the registry, append the
 *         results as `tool` role messages, and continue.
 *      d. If there are NO tool_calls AND stop_reason === 'stop', the task is
 *         complete — break.
 *      e. If max iterations is reached, throw (prevents infinite loops).
 *
 * The loop does NOT decide when a task is "done" — the LLM does, by emitting
 * a `stop` without tool calls. The loop's job is to faithfully shuttle
 * messages back and forth, execute tools safely, and bound the runtime.
 *
 * Design notes:
 *  - `messageHistory` is private and mutated in place. The loop owns it.
 *  - Tool results are appended as one `tool` message per tool_call, matching
 *    the OpenAI format. Multiple tool_calls in one assistant message are
 *    executed sequentially (parallel execution is a Phase 2 concern).
 *  - Tool execution errors are fed back to the LLM as `tool` role messages
 *    with `Error: ...` content. The LLM can then decide to retry or give up.
 *  - `console.log` is used for visibility; the verify script greps these.
 */
import type { LLMMessage, LLMProvider, LLMResponse } from './types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/types.js';

const SYSTEM_PROMPT =
  'You are Kovix, an autonomous AI engineer. You break down tasks and use tools to accomplish them. Do not just talk. Use tools to read and write files to complete the task.';

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

  /**
   * Run the agent loop against a user prompt. Returns when the LLM emits a
   * `stop` without tool calls, or throws when max iterations is exceeded.
   */
  async runTask(userPrompt: string): Promise<void> {
    // Seed history with system + user. The system prompt is added once; we
    // do NOT re-add it on subsequent iterations.
    this.messageHistory.push({ role: 'system', content: this.systemPrompt });
    this.messageHistory.push({ role: 'user', content: userPrompt });

    const toolCtx: ToolContext = { workspaceRoot: this.workspaceRoot };

    for (let iteration = 1; iteration <= this.maxIterations; iteration++) {
      console.log(`\n--- Iteration ${iteration}/${this.maxIterations} ---`);

      // a. Call the LLM with full history + tool schemas.
      const response: LLMResponse = await this.provider.chat(
        this.messageHistory,
        this.registry.getAllToolSchemas(),
      );

      // b. Append the assistant message to history. We must include tool_calls
      //    if present, so the LLM's next call sees the prior request.
      const assistantMsg: LLMMessage = {
        role: 'assistant',
        content: response.content,
      };
      if (response.tool_calls && response.tool_calls.length > 0) {
        assistantMsg.tool_calls = response.tool_calls;
      }
      this.messageHistory.push(assistantMsg);

      // c. Print any text content the LLM emitted alongside tool calls.
      if (response.content) {
        console.log(`[llm] ${response.content}`);
      }

      // d. If tool_calls present, execute each and append results.
      if (response.tool_calls && response.tool_calls.length > 0) {
        for (const call of response.tool_calls) {
          console.log(`[tool_call] ${call.function.name}(${call.function.arguments})`);
          const result = await this.registry.executeTool(
            call.function.name,
            call.function.arguments,
            toolCtx,
          );
          // Truncate long results in the log for readability. The full result
          // is always sent to the LLM untruncated.
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
        // Continue the loop — the LLM gets to react to the tool results.
        continue;
      }

      // e. No tool calls. If the LLM says it's done, we're done.
      if (response.stop_reason === 'stop') {
        console.log('[done] task complete');
        return;
      }

      // Other stop reasons (length, content_filter, unknown). We log and
      // continue — the LLM may recover on the next iteration. content_filter
      // is treated the same way: a one-off block shouldn't kill the run.
      console.log(`[note] non-stop stop_reason: ${response.stop_reason}`);
    }

    throw new Error(
      `AgentLoop exceeded max iterations (${this.maxIterations}) without completing the task`,
    );
  }
}
