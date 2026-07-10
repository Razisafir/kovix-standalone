/**
 * Tool type definitions — Kovix 2.0 Phase 1.
 *
 * A "tool" is a capability the autonomous agent can invoke: read a file, write
 * a file, list a directory, etc. Each tool carries its own Zod schema for
 * runtime argument validation, plus an OpenAI-compatible JSON schema for the
 * LLM function-calling interface.
 *
 * Design notes:
 *  - Two layers of types: `ToolDefinition<Args>` (generic, type-safe at
 *    authoring time) and `RegisteredTool` (type-erased, stored in the
 *    registry). The registry accepts the generic and erases internally —
 *    callers never have to cast.
 *  - No `any` types. Argument types flow through Zod; runtime values are
 *    validated before reaching `execute`. The erased boundary uses `unknown`.
 *  - `execute` returns `Promise<string>` (not `Promise<unknown>`) because LLM
 *    tool-result messages are always text. Tools that produce structured data
 *    should `JSON.stringify` it themselves.
 */
import type { z } from 'zod';

/**
 * OpenAI-compatible function-calling schema. This is the shape that gets
 * passed to the LLM provider's `tools` parameter.
 *
 * Spec: https://platform.openai.com/docs/guides/function-calling
 */
export interface ToolFunctionSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    /** JSON Schema object describing the tool's arguments. */
    parameters: Record<string, unknown>;
  };
}

/**
 * Author-facing tool definition. Generic over `Args` so `execute` is fully
 * type-safe at the call site — no casting required when authoring a tool.
 *
 * @template Args - The parsed-arguments type, inferred from `parameters`.
 */
export interface ToolDefinition<Args> {
  name: string;
  description: string;
  /** Zod schema used to parse + validate the raw args before `execute`. */
  parameters: z.ZodSchema<Args>;
  /** Receives the already-parsed, type-safe args. Returns a string for the LLM. */
  execute: (args: Args, ctx: ToolContext) => Promise<string>;
}

/**
 * Per-invocation context handed to every tool. Carries the workspace root so
 * tools can resolve relative paths safely, without relying on module-level
 * globals.
 */
export interface ToolContext {
  /** Absolute path to the workspace root. All tool paths are relative to this. */
  workspaceRoot: string;
}

/**
 * Type-erased Zod schema type used by the registry.
 *
 * In zod v4 the v3 form `ZodType<unknown, ZodTypeDef, unknown>` no longer
 * compiles — `ZodTypeDef` is gone and the internal `$ZodType` shape changed.
 * `z.ZodType<unknown>` is the v4-correct way to say "some Zod schema whose
 * parsed output is `unknown`". Runtime validation behaviour is unchanged.
 */
export type ErasedZodSchema = z.ZodType<unknown>;

/**
 * Type-erased tool stored in the registry. The `execute` signature takes
 * `unknown` because the registry doesn't know the specific `Args` type —
 * but `parameters` is still a Zod schema that will parse + validate the
 * raw args before `execute` is called, so `execute` receives a value that
 * has been runtime-checked against the schema.
 *
 * The cast from `ToolDefinition<Args>` to `RegisteredTool` happens once at
 * registration time, inside `ToolRegistry.registerTool`.
 */
export interface RegisteredTool {
  name: string;
  description: string;
  /** Type-erased Zod schema. Used to parse raw args before execution. */
  parameters: ErasedZodSchema;
  execute: (args: unknown, ctx: ToolContext) => Promise<string>;
}

/**
 * Result of executing a tool. Always a string for LLM consumption; `ok`
 * distinguishes success from error so the registry can format the message
 * consistently ("Error: <message>" on failure).
 */
export interface ToolExecutionResult {
  ok: boolean;
  /** The tool's textual output, or the error message if `ok === false`. */
  output: string;
}
