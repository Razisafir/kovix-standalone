/**
 * LLM provider + message types — Kovix 2.0 Phase 1.
 *
 * This is a minimal, OpenAI/OpenRouter-compatible interface. Real providers
 * (OpenAI SDK, OpenRouter SDK, Anthropic SDK, Ollama) are adapted to this
 * shape via a thin wrapper; the AgentLoop itself never imports an LLM SDK.
 *
 * Design notes:
 *  - `stop_reason` is a string union plus `string` to allow provider-specific
 *    reasons without forcing a cast. The AgentLoop only branches on `'stop'`
 *    and `'tool_use'`; everything else is treated as "keep going or give up".
 *  - `tool_calls.function.arguments` is a JSON-encoded string (NOT a parsed
 *    object). This matches the OpenAI wire format and forces explicit parsing
 *    at the tool-execution boundary, where Zod catches malformed input.
 *  - `content` is `string | null` because OpenAI returns `null` when the
 *    assistant emits only tool calls.
 */
import type { ToolFunctionSchema } from '../tools/types.js';

/**
 * A single tool call as returned by the LLM in an assistant message.
 */
export interface LLMToolCall {
  /** Unique ID for this call. Used to match the tool-result message back. */
  id: string;
  type: 'function';
  function: {
    name: string;
    /** JSON-encoded arguments string. Parsed by the registry before execute. */
    arguments: string;
  };
}

/**
 * A message in the conversation history. Mirrors the OpenAI chat format.
 *
 * - `system`    — high-level instructions, prepended once at the start.
 * - `user`      — the human's prompt.
 * - `assistant` — the LLM's response (text and/or tool_calls).
 * - `tool`      — the result of executing a tool_call. Must reference the
 *                 originating call via `tool_call_id`.
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** Present on assistant messages that requested tool calls. */
  tool_calls?: LLMToolCall[];
  /** Present on `tool` role messages; matches the originating `LLMToolCall.id`. */
  tool_call_id?: string;
  /** Present on `tool` role messages; the name of the tool that was called. */
  name?: string;
}

/**
 * The LLM's response to a single `chat()` call.
 */
export interface LLMResponse {
  role: 'assistant';
  /** Text content, or `null` if the LLM only emitted tool_calls. */
  content: string | null;
  /** Tool calls requested by the LLM, if any. */
  tool_calls?: LLMToolCall[];
  /**
   * Why the LLM stopped generating. Standard values:
   *  - `'stop'`          — natural end of message, no tool call requested.
   *  - `'tool_use'`      — LLM emitted a tool_call and is waiting for the result.
   *  - `'length'`        — hit max_tokens mid-message.
   *  - `'content_filter' — blocked by safety filter.
   * Providers may emit other values; the AgentLoop treats unknowns as "keep going".
   */
  stop_reason: 'stop' | 'tool_use' | 'length' | 'content_filter' | (string & {});
}

/**
 * The provider interface every LLM backend must implement.
 *
 * `chat()` is the only method — it takes the full conversation history plus
 * the available tool schemas, and returns the LLM's response. Stateless from
 * the caller's perspective; the AgentLoop owns the history.
 */
export interface LLMProvider {
  chat(messages: LLMMessage[], tools?: ToolFunctionSchema[]): Promise<LLMResponse>;
}
