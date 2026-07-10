/**
 * ToolRegistry — central store for tools available to the autonomous agent.
 *
 * Responsibilities:
 *  1. Accept type-safe `ToolDefinition<Args>` registrations and erase the
 *     generic internally so all tools can live in one Map.
 *  2. Expose OpenAI-compatible function schemas (`getAllToolSchemas`) for the
 *     LLM provider's `tools` parameter.
 *  3. Execute a tool by name: parse the raw JSON args through the tool's Zod
 *     schema, call `execute`, and return the string result. Errors are caught
 *     and surfaced as `"Error: <message>"` so the LLM can react to them
 *     instead of crashing the loop.
 *
 * No `any` types. The erased boundary uses `unknown` + a single `as` cast at
 * registration time, which is the standard pattern for heterogeneous
 * registries in TypeScript.
 */
import { toJSONSchema } from 'zod';
import type {
  ErasedZodSchema,
  RegisteredTool,
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
  ToolFunctionSchema,
} from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  /**
   * Register a tool. Generic over `Args` so the caller's `execute` is fully
   * type-safe. The generic is erased when stored.
   *
   * @throws if a tool with the same name is already registered.
   */
  registerTool<Args>(tool: ToolDefinition<Args>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    // Type-erasure cast. Safe because:
    //  - The Zod schema still validates at runtime; only the static type is widened.
    //  - `execute` is called with the schema-parsed value, which matches `Args`
    //    at runtime even though the static type is `unknown`.
    const erased: RegisteredTool = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as ErasedZodSchema,
      execute: tool.execute as (args: unknown, ctx: ToolContext) => Promise<string>,
    };
    this.tools.set(tool.name, erased);
  }

  /**
   * Look up a registered tool by name. Returns `undefined` if not found.
   */
  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Returns OpenAI-compatible function schemas for every registered tool.
   * The order is insertion-order (Map preserves it), which keeps the LLM's
   * tool list deterministic across runs.
   */
  getAllToolSchemas(): ToolFunctionSchema[] {
    return Array.from(this.tools.values()).map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        // `toJSONSchema` returns a Draft 2020-12 JSON Schema object. OpenAI's
        // function-calling accepts this format directly. The double cast
        // through `unknown` is needed because zod v4's `toJSONSchema` has
        // two overloads (schema | registry) and the erased `ZodType<unknown>`
        // doesn't cleanly satisfy either signature, even though it's a
        // perfectly valid Zod schema at runtime.
        parameters: toJSONSchema(
          tool.parameters as unknown as Parameters<typeof toJSONSchema>[0],
        ) as Record<string, unknown>,
      },
    }));
  }

  /**
   * Execute a tool by name with raw JSON-encoding args.
   *
   * Flow:
   *   1. Look up the tool. If missing, return an error result.
   *   2. Parse `argsJson`. If JSON.parse fails, return an error result.
   *   3. Validate the parsed object through the tool's Zod schema. If invalid,
   *      return an error result with the Zod issue tree.
   *   4. Call `execute` with the parsed args. If it throws, return an error
   *      result with the exception message.
   *   5. Otherwise return the tool's string output.
   *
   * Errors are surfaced as strings (not thrown) so the AgentLoop can feed
   * them back to the LLM as tool-result messages — the standard pattern for
   * agent loops.
   */
  async executeTool(
    name: string,
    argsJson: string,
    ctx: ToolContext,
  ): Promise<ToolExecutionResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, output: `Error: unknown tool "${name}"` };
    }

    let parsedArgs: unknown;
    try {
      parsedArgs = JSON.parse(argsJson);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `Error: invalid JSON arguments for "${name}": ${msg}` };
    }

    const parseResult = tool.parameters.safeParse(parsedArgs);
    if (!parseResult.success) {
      const issues = JSON.stringify(parseResult.error.issues, null, 2);
      return {
        ok: false,
        output: `Error: invalid arguments for "${name}": ${issues}`,
      };
    }

    try {
      const output = await tool.execute(parseResult.data, ctx);
      return { ok: true, output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, output: `Error: tool "${name}" threw: ${msg}` };
    }
  }
}
